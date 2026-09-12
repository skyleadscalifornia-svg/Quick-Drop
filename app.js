const API = "/api";

const textInput = document.getElementById("textInput");
const charCount = document.getElementById("charCount");
const saveTextBtn = document.getElementById("saveTextBtn");
const saveStatus = document.getElementById("saveStatus");

const fileInput = document.getElementById("fileInput");
const uploadButton = document.getElementById("uploadButton");

const uploadProgressContainer = document.getElementById(
  "uploadProgressContainer"
);
const uploadFileName = document.getElementById("uploadFileName");
const uploadProgressText = document.getElementById("uploadProgressText");
const uploadProgressBar = document.getElementById("uploadProgressBar");

const itemsContainer = document.getElementById("itemsContainer");
const emptyState = document.getElementById("emptyState");
const deleteAllButton = document.getElementById("deleteAllButton");

const deleteModal = document.getElementById("deleteModal");
const cancelDeleteButton = document.getElementById("cancelDeleteButton");
const confirmDeleteButton = document.getElementById("confirmDeleteButton");

const previewModal = document.getElementById("previewModal");
const previewBackdrop = document.getElementById("previewBackdrop");
const closePreviewButton = document.getElementById("closePreviewButton");
const previewContent = document.getElementById("previewContent");

const toast = document.getElementById("toast");
const toastMessage = document.getElementById("toastMessage");

const connectionText = document.getElementById("connectionText");

let items = [];
let toastTimer = null;


/* =========================
   INITIALIZE
========================= */

document.addEventListener("DOMContentLoaded", () => {
  updateCharacterCount();
  loadItems();
});


/* =========================
   TEXT INPUT
========================= */

textInput.addEventListener("input", updateCharacterCount);

function updateCharacterCount() {
  const count = textInput.value.length;

  charCount.textContent =
    `${count.toLocaleString()} character${count === 1 ? "" : "s"}`;
}


/* =========================
   SAVE TEXT
========================= */

saveTextBtn.addEventListener("click", saveText);

async function saveText() {
  const text = textInput.value;

  if (!text.trim()) {
    showToast("Enter some text first.");
    textInput.focus();
    return;
  }

  setSaveStatus("Saving...", "loading");
  saveTextBtn.disabled = true;

  try {
    const response = await fetch(`${API}/text`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      },
      body: text
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response));
    }

    textInput.value = "";
    updateCharacterCount();

    setSaveStatus("Saved", "success");
    showToast("Text saved.");

    await loadItems();
  } catch (error) {
    console.error(error);

    setSaveStatus("Failed", "error");
    showToast(error.message || "Could not save text.");
  } finally {
    saveTextBtn.disabled = false;

    setTimeout(() => {
      if (saveStatus) {
        setSaveStatus("Ready", "ready");
      }
    }, 1800);
  }
}


/* =========================
   SAVE STATUS
========================= */

function setSaveStatus(text, state = "ready") {
  if (!saveStatus) return;

  const dot = saveStatus.querySelector(".save-dot");
  const label = saveStatus.querySelector("span:last-child");

  if (label) {
    label.textContent = text;
  }

  if (dot) {
    if (state === "success") {
      dot.style.background = "#36a269";
    } else if (state === "error") {
      dot.style.background = "#d92d20";
    } else if (state === "loading") {
      dot.style.background = "#737373";
    } else {
      dot.style.background = "#d5d5d5";
    }
  }
}


/* =========================
   FILE UPLOAD
========================= */

uploadButton.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files || []);

  if (!files.length) {
    return;
  }

  for (const file of files) {
    await uploadFile(file);
  }

  fileInput.value = "";
  await loadItems();
});


async function uploadFile(file) {
  const MAX_FILE_SIZE = 100 * 1024 * 1024;

  if (file.size > MAX_FILE_SIZE) {
    showToast(`${file.name} is larger than 100 MB.`);
    return;
  }

  showUploadProgress(file.name);

  try {
    await uploadFileWithProgress(file);

    setUploadProgress(100);
    showToast(`${file.name} uploaded.`);

    await sleep(250);
  } catch (error) {
    console.error(error);
    showToast(error.message || `Could not upload ${file.name}.`);
  } finally {
    hideUploadProgress();
  }
}


/*
 * XMLHttpRequest is used here instead of fetch
 * because it gives us real upload progress.
 */
function uploadFileWithProgress(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open("POST", `${API}/upload`);

    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream"
    );

    xhr.setRequestHeader(
      "X-Filename",
      encodeURIComponent(file.name)
    );

    xhr.setRequestHeader(
      "X-File-Type",
      file.type || "application/octet-stream"
    );

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }

      const percent = Math.round(
        (event.loaded / event.total) * 100
      );

      setUploadProgress(percent);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        let message = "Upload failed.";

        try {
          const data = JSON.parse(xhr.responseText);

          if (data.error) {
            message = data.error;
          }
        } catch {
          // Ignore invalid JSON.
        }

        reject(new Error(message));
      }
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Network error during upload."));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error("Upload cancelled."));
    });

    xhr.send(file);
  });
}


function showUploadProgress(filename) {
  uploadProgressContainer.classList.remove("hidden");

  uploadFileName.textContent = filename;
  uploadProgressText.textContent = "0%";
  uploadProgressBar.style.width = "0%";
}


function setUploadProgress(percent) {
  const safePercent = Math.max(
    0,
    Math.min(100, Number(percent) || 0)
  );

  uploadProgressText.textContent = `${safePercent}%`;
  uploadProgressBar.style.width = `${safePercent}%`;
}


function hideUploadProgress() {
  setTimeout(() => {
    uploadProgressContainer.classList.add("hidden");
    uploadProgressBar.style.width = "0%";
  }, 350);
}


/* =========================
   LOAD ITEMS
========================= */

async function loadItems() {
  try {
    setConnection("Loading...", false);

    const response = await fetch(`${API}/items`, {
      method: "GET",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response));
    }

    const data = await response.json();

    items = Array.isArray(data.items)
      ? data.items
      : [];

    renderItems();

    setConnection("Connected", true);
  } catch (error) {
    console.error(error);

    setConnection("Connection error", false);

    items = [];
    renderItems();

    showToast(
      "Could not connect to QuickDrop. Please refresh the page."
    );
  }
}


/* =========================
   RENDER ITEMS
========================= */

function renderItems() {
  itemsContainer.innerHTML = "";

  if (!items.length) {
    emptyState.classList.remove("hidden");
    deleteAllButton.disabled = true;
    return;
  }

  emptyState.classList.add("hidden");
  deleteAllButton.disabled = false;

  items.forEach((item) => {
    itemsContainer.appendChild(createItemCard(item));
  });
}


function createItemCard(item) {
  const card = document.createElement("article");
  card.className = "item-card";

  const top = document.createElement("div");
  top.className = "item-top";

  const icon = document.createElement("div");
  icon.className = "item-icon";
  icon.textContent = item.type === "text" ? "T" : getFileIcon(item.mimeType);

  const info = document.createElement("div");
  info.className = "item-info";

  const name = document.createElement("div");
  name.className = "item-name";
  name.textContent =
    item.type === "text"
      ? "Text"
      : item.name || "Unnamed file";

  const meta = document.createElement("div");
  meta.className = "item-meta";

  if (item.type === "text") {
    meta.textContent = formatDate(item.createdAt);
  } else {
    meta.textContent =
      `${formatFileSize(item.size)} • ${formatDate(item.createdAt)}`;
  }

  info.appendChild(name);
  info.appendChild(meta);

  top.appendChild(icon);
  top.appendChild(info);

  card.appendChild(top);

  if (item.type === "text") {
    const preview = document.createElement("div");
    preview.className = "item-text-preview";
    preview.textContent =
      item.preview || "Text item";

    card.appendChild(preview);
  } else if (isImage(item.mimeType)) {
    const image = document.createElement("img");

    image.className = "item-thumbnail";
    image.loading = "lazy";
    image.alt = item.name || "Uploaded image";
    image.src = `${API}/download/${encodeURIComponent(item.id)}`;

    card.appendChild(image);
  }

  const actions = document.createElement("div");
  actions.className = "item-actions";

  if (item.type === "text") {
    const copyButton = createActionButton(
      "Copy",
      async () => {
        await copyTextItem(item);
      }
    );

    const viewButton = createActionButton(
      "View",
      async () => {
        await viewTextItem(item);
      }
    );

    actions.appendChild(copyButton);
    actions.appendChild(viewButton);
  } else {
    if (isImage(item.mimeType) || isVideo(item.mimeType)) {
      const previewButton = createActionButton(
        "Preview",
        async () => {
          openFilePreview(item);
        }
      );

      actions.appendChild(previewButton);
    }

    const downloadButton = createActionButton(
      "Download",
      async () => {
        downloadItem(item);
      }
    );

    actions.appendChild(downloadButton);
  }

  const deleteButton = createActionButton(
    "Delete",
    async () => {
      await deleteItem(item);
    }
  );

  deleteButton.classList.add("delete");

  actions.appendChild(deleteButton);

  card.appendChild(actions);

  return card;
}


function createActionButton(label, handler) {
  const button = document.createElement("button");

  button.type = "button";
  button.className = "item-action";
  button.textContent = label;

  button.addEventListener("click", async () => {
    try {
      button.disabled = true;
      await handler();
    } finally {
      button.disabled = false;
    }
  });

  return button;
}


/* =========================
   TEXT ACTIONS
========================= */

async function copyTextItem(item) {
  try {
    const text = await getItemText(item.id);

    await navigator.clipboard.writeText(text);

    showToast("Text copied.");
  } catch (error) {
    console.error(error);
    showToast("Could not copy text.");
  }
}


async function viewTextItem(item) {
  try {
    const text = await getItemText(item.id);

    previewContent.innerHTML = "";

    const textElement = document.createElement("div");
    textElement.className = "preview-text";
    textElement.textContent = text;

    previewContent.appendChild(textElement);

    previewModal.classList.remove("hidden");
  } catch (error) {
    console.error(error);
    showToast("Could not open text.");
  }
}


async function getItemText(id) {
  const response = await fetch(
    `${API}/item/${encodeURIComponent(id)}`
  );

  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  return await response.text();
}


/* =========================
   FILE PREVIEW
========================= */

function openFilePreview(item) {
  previewContent.innerHTML = "";

  const url =
    `${API}/download/${encodeURIComponent(item.id)}`;

  if (isImage(item.mimeType)) {
    const image = document.createElement("img");

    image.src = url;
    image.alt = item.name || "Image preview";

    previewContent.appendChild(image);
  } else if (isVideo(item.mimeType)) {
    const video = document.createElement("video");

    video.src = url;
    video.controls = true;
    video.autoplay = true;

    previewContent.appendChild(video);
  }

  previewModal.classList.remove("hidden");
}


/* =========================
   DOWNLOAD
========================= */

function downloadItem(item) {
  const link = document.createElement("a");

  link.href =
    `${API}/download/${encodeURIComponent(item.id)}`;

  link.download = item.name || "download";

  document.body.appendChild(link);
  link.click();
  link.remove();

  showToast("Download started.");
}


/* =========================
   DELETE ONE
========================= */

async function deleteItem(item) {
  const confirmed = window.confirm(
    `Delete "${item.type === "text" ? "this text" : item.name}"?`
  );

  if (!confirmed) {
    return;
  }

  try {
    const response = await fetch(
      `${API}/item/${encodeURIComponent(item.id)}`,
      {
        method: "DELETE"
      }
    );

    if (!response.ok) {
      throw new Error(await getErrorMessage(response));
    }

    showToast("Item deleted.");

    await loadItems();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not delete item.");
  }
}


/* =========================
   DELETE ALL
========================= */

deleteAllButton.addEventListener("click", () => {
  if (!items.length) {
    return;
  }

  deleteModal.classList.remove("hidden");
});


cancelDeleteButton.addEventListener("click", closeDeleteModal);

deleteModal
  .querySelector(".modal-backdrop")
  .addEventListener("click", closeDeleteModal);


function closeDeleteModal() {
  deleteModal.classList.add("hidden");
}


confirmDeleteButton.addEventListener("click", deleteAllItems);

async function deleteAllItems() {
  confirmDeleteButton.disabled = true;

  try {
    const response = await fetch(`${API}/delete-all`, {
      method: "DELETE"
    });

    if (!response.ok) {
      throw new Error(await getErrorMessage(response));
    }

    closeDeleteModal();

    showToast("All items deleted.");

    await loadItems();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not delete all items.");
  } finally {
    confirmDeleteButton.disabled = false;
  }
}


/* =========================
   PREVIEW CLOSE
========================= */

closePreviewButton.addEventListener(
  "click",
  closePreview
);

previewBackdrop.addEventListener(
  "click",
  closePreview
);

function closePreview() {
  previewModal.classList.add("hidden");
  previewContent.innerHTML = "";
}


/* =========================
   ESCAPE KEY
========================= */

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }

  closeDeleteModal();
  closePreview();
});


/* =========================
   CONNECTION STATUS
========================= */

function setConnection(text, connected) {
  if (!connectionText) {
    return;
  }

  connectionText.textContent = text;

  const dot = document.querySelector(".status-dot");

  if (dot) {
    dot.style.background = connected
      ? "#36a269"
      : "#d5d5d5";
  }
}


/* =========================
   TOAST
========================= */

function showToast(message) {
  clearTimeout(toastTimer);

  toastMessage.textContent = message;
  toast.classList.add("show");

  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2600);
}


/* =========================
   HELPERS
========================= */

function formatFileSize(bytes) {
  const size = Number(bytes) || 0;

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}


function formatDate(value) {
  if (!value) {
    return "Just now";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Just now";
  }

  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}


function getFileIcon(mimeType = "") {
  if (mimeType.startsWith("image/")) {
    return "▧";
  }

  if (mimeType.startsWith("video/")) {
    return "▶";
  }

  if (mimeType.startsWith("audio/")) {
    return "♪";
  }

  if (mimeType.includes("pdf")) {
    return "P";
  }

  if (
    mimeType.includes("zip") ||
    mimeType.includes("compressed") ||
    mimeType.includes("archive")
  ) {
    return "Z";
  }

  return "F";
}


function isImage(mimeType = "") {
  return mimeType.startsWith("image/");
}


function isVideo(mimeType = "") {
  return mimeType.startsWith("video/");
}


async function getErrorMessage(response) {
  try {
    const data = await response.json();

    if (data && data.error) {
      return data.error;
    }
  } catch {
    // Ignore invalid JSON.
  }

  return `Request failed (${response.status}).`;
}


function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
