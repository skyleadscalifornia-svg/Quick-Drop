const DATA_PREFIX = "data/";
const ITEM_PREFIX = "items/";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      /*
       * =========================
       * API ROUTES
       * =========================
       */

      if (url.pathname === "/api/items" && request.method === "GET") {
        return await listItems(env);
      }

      if (url.pathname === "/api/text" && request.method === "POST") {
        return await createText(request, env);
      }

      if (url.pathname === "/api/upload" && request.method === "POST") {
        return await uploadFile(request, env);
      }

      if (
        url.pathname.startsWith("/api/item/") &&
        request.method === "GET"
      ) {
        const id = getIdFromPath(url.pathname, "/api/item/");
        return await getItem(id, env);
      }

      if (
        url.pathname.startsWith("/api/download/") &&
        request.method === "GET"
      ) {
        const id = getIdFromPath(url.pathname, "/api/download/");
        return await downloadItem(id, request, env);
      }

      if (
        url.pathname.startsWith("/api/item/") &&
        request.method === "DELETE"
      ) {
        const id = getIdFromPath(url.pathname, "/api/item/");
        return await deleteItem(id, env);
      }

      if (
        url.pathname === "/api/delete-all" &&
        request.method === "DELETE"
      ) {
        return await deleteAllItems(env);
      }


      /*
       * =========================
       * STATIC WEBSITE
       * =========================
       */

      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return new Response("QuickDrop", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8"
        }
      });

    } catch (error) {
      console.error("Worker error:", error);

      return jsonResponse(
        {
          error: "Something went wrong on the server."
        },
        500
      );
    }
  }
};


/* =========================================================
   CREATE TEXT
========================================================= */

async function createText(request, env) {
  const text = await request.text();

  if (!text.trim()) {
    return jsonResponse(
      {
        error: "Text cannot be empty."
      },
      400
    );
  }

  const MAX_TEXT_SIZE = 100000;

  if (text.length > MAX_TEXT_SIZE) {
    return jsonResponse(
      {
        error: "Text is too large. Maximum is 100,000 characters."
      },
      400
    );
  }

  const id = crypto.randomUUID();

  const dataKey = `${DATA_PREFIX}${id}.txt`;
  const metadataKey = `${ITEM_PREFIX}${id}.json`;

  const createdAt = new Date().toISOString();

  const metadata = {
    id,
    type: "text",
    name: "Text",
    mimeType: "text/plain",
    size: new TextEncoder().encode(text).length,
    createdAt,
    objectKey: dataKey,
    preview: text.slice(0, 1000)
  };

  /*
   * Store actual text.
   */
  await env.QUICKDROP.put(dataKey, text, {
    httpMetadata: {
      contentType: "text/plain; charset=utf-8"
    }
  });

  /*
   * Store metadata.
   */
  await env.QUICKDROP.put(
    metadataKey,
    JSON.stringify(metadata),
    {
      httpMetadata: {
        contentType: "application/json; charset=utf-8"
      }
    }
  );

  return jsonResponse(
    {
      success: true,
      item: metadata
    },
    201
  );
}


/* =========================================================
   UPLOAD FILE
========================================================= */

async function uploadFile(request, env) {
  const MAX_FILE_SIZE = 100 * 1024 * 1024;

  const contentLength = Number(
    request.headers.get("Content-Length") || 0
  );

  if (contentLength > MAX_FILE_SIZE) {
    return jsonResponse(
      {
        error: "File is larger than 100 MB."
      },
      413
    );
  }

  const filenameHeader = request.headers.get("X-Filename");

  let filename = "download";

  if (filenameHeader) {
    try {
      filename = decodeURIComponent(filenameHeader);
    } catch {
      filename = filenameHeader;
    }
  }

  filename = cleanFilename(filename);

  const mimeType =
    request.headers.get("X-File-Type") ||
    request.headers.get("Content-Type") ||
    "application/octet-stream";

  const id = crypto.randomUUID();

  /*
   * Never use the user's filename as the R2 key.
   * UUID keeps the storage key safe and unique.
   */
  const dataKey = `${DATA_PREFIX}${id}/file`;
  const metadataKey = `${ITEM_PREFIX}${id}.json`;

  const createdAt = new Date().toISOString();

  /*
   * Stream the browser's file directly into R2.
   */
  await env.QUICKDROP.put(
    dataKey,
    request.body,
    {
      httpMetadata: {
        contentType: mimeType,
        contentDisposition:
          `attachment; filename="${escapeFilename(filename)}"`
      }
    }
  );

  /*
   * Get the actual stored object's size.
   */
  const storedObject = await env.QUICKDROP.head(dataKey);

  const size = storedObject
    ? storedObject.size
    : contentLength;

  const metadata = {
    id,
    type: "file",
    name: filename,
    mimeType,
    size,
    createdAt,
    objectKey: dataKey
  };

  await env.QUICKDROP.put(
    metadataKey,
    JSON.stringify(metadata),
    {
      httpMetadata: {
        contentType: "application/json; charset=utf-8"
      }
    }
  );

  return jsonResponse(
    {
      success: true,
      item: metadata
    },
    201
  );
}


/* =========================================================
   LIST ITEMS
========================================================= */

async function listItems(env) {
  const items = [];

  let cursor;

  /*
   * R2 list() returns pages.
   * Continue until everything has been read.
   */
  do {
    const result = await env.QUICKDROP.list({
      prefix: ITEM_PREFIX,
      limit: 1000,
      cursor
    });

    for (const object of result.objects) {
      try {
        const metadataObject =
          await env.QUICKDROP.get(object.key);

        if (!metadataObject) {
          continue;
        }

        const metadataText =
          await metadataObject.text();

        const metadata =
          JSON.parse(metadataText);

        items.push(metadata);
      } catch (error) {
        console.error(
          "Could not read metadata:",
          object.key,
          error
        );
      }
    }

    cursor = result.truncated
      ? result.cursor
      : undefined;

  } while (cursor);


  /*
   * Newest items first.
   */
  items.sort((a, b) => {
    return (
      new Date(b.createdAt).getTime() -
      new Date(a.createdAt).getTime()
    );
  });

  return jsonResponse({
    items
  });
}


/* =========================================================
   GET TEXT ITEM
========================================================= */

async function getItem(id, env) {
  if (!id) {
    return jsonResponse(
      {
        error: "Invalid item ID."
      },
      400
    );
  }

  const metadata =
    await getMetadata(id, env);

  if (!metadata) {
    return jsonResponse(
      {
        error: "Item not found."
      },
      404
    );
  }

  /*
   * This endpoint is primarily for text items.
   */
  if (metadata.type !== "text") {
    return jsonResponse(
      {
        error: "This item is not text."
      },
      400
    );
  }

  const object =
    await env.QUICKDROP.get(metadata.objectKey);

  if (!object) {
    return jsonResponse(
      {
        error: "Stored item could not be found."
      },
      404
    );
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}


/* =========================================================
   DOWNLOAD FILE
========================================================= */

async function downloadItem(id, request, env) {
  if (!id) {
    return new Response(
      "Invalid item ID.",
      {
        status: 400
      }
    );
  }

  const metadata =
    await getMetadata(id, env);

  if (!metadata) {
    return new Response(
      "Item not found.",
      {
        status: 404
      }
    );
  }

  const object =
    await env.QUICKDROP.get(metadata.objectKey);

  if (!object) {
    return new Response(
      "Stored file not found.",
      {
        status: 404
      }
    );
  }

  /*
   * Support HTTP range requests for videos/media.
   */
  const headers = new Headers();

  headers.set(
    "Content-Type",
    metadata.mimeType ||
      "application/octet-stream"
  );

  headers.set(
    "Content-Disposition",
    `attachment; filename="${escapeFilename(metadata.name || "download")}"`
  );

  headers.set(
    "Cache-Control",
    "no-store"
  );

  /*
   * R2 can provide range-aware responses.
   */
  if (request.headers.has("Range")) {
    const range = request.headers.get("Range");

    const rangeObject =
      await env.QUICKDROP.get(
        metadata.objectKey,
        {
          range: parseRange(
            range,
            object.size
          )
        }
      );

    if (rangeObject) {
      headers.set(
        "Content-Range",
        `bytes ${rangeObject.range.offset}-${rangeObject.range.offset + rangeObject.range.length - 1}/${object.size}`
      );

      headers.set(
        "Content-Length",
        String(rangeObject.range.length)
      );

      return new Response(
        rangeObject.body,
        {
          status: 206,
          headers
        }
      );
    }
  }

  headers.set(
    "Content-Length",
    String(object.size)
  );

  return new Response(
    object.body,
    {
      status: 200,
      headers
    }
  );
}


/* =========================================================
   DELETE ONE ITEM
========================================================= */

async function deleteItem(id, env) {
  if (!id) {
    return jsonResponse(
      {
        error: "Invalid item ID."
      },
      400
    );
  }

  const metadata =
    await getMetadata(id, env);

  if (!metadata) {
    return jsonResponse(
      {
        error: "Item not found."
      },
      404
    );
  }

  /*
   * Delete actual data first.
   */
  await env.QUICKDROP.delete(
    metadata.objectKey
  );

  /*
   * Then delete metadata.
   */
  await env.QUICKDROP.delete(
    `${ITEM_PREFIX}${id}.json`
  );

  return jsonResponse({
    success: true
  });
}


/* =========================================================
   DELETE ALL ITEMS
========================================================= */

async function deleteAllItems(env) {
  const keysToDelete = [];

  let cursor;

  /*
   * Find all metadata objects.
   */
  do {
    const result = await env.QUICKDROP.list({
      prefix: ITEM_PREFIX,
      limit: 1000,
      cursor
    });

    for (const object of result.objects) {
      keysToDelete.push(object.key);
    }

    cursor = result.truncated
      ? result.cursor
      : undefined;

  } while (cursor);


  /*
   * Read metadata so we can also delete
   * the actual file/text objects.
   */
  const dataKeys = [];

  for (const metadataKey of keysToDelete) {
    try {
      const object =
        await env.QUICKDROP.get(metadataKey);

      if (!object) {
        continue;
      }

      const metadata =
        JSON.parse(await object.text());

      if (metadata.objectKey) {
        dataKeys.push(metadata.objectKey);
      }
    } catch (error) {
      console.error(
        "Could not read metadata during delete-all:",
        metadataKey,
        error
      );
    }
  }


  /*
   * R2 allows up to 1000 keys per delete request.
   */
  await deleteInBatches(
    env.QUICKDROP,
    dataKeys
  );

  await deleteInBatches(
    env.QUICKDROP,
    keysToDelete
  );

  return jsonResponse({
    success: true,
    deleted: keysToDelete.length
  });
}


/* =========================================================
   METADATA
========================================================= */

async function getMetadata(id, env) {
  const metadataObject =
    await env.QUICKDROP.get(
      `${ITEM_PREFIX}${id}.json`
    );

  if (!metadataObject) {
    return null;
  }

  try {
    return JSON.parse(
      await metadataObject.text()
    );
  } catch {
    return null;
  }
}


/* =========================================================
   BATCH DELETE
========================================================= */

async function deleteInBatches(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);

    if (batch.length) {
      await bucket.delete(batch);
    }
  }
}


/* =========================================================
   RANGE PARSER
========================================================= */

function parseRange(rangeHeader, size) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return undefined;
  }

  const value =
    rangeHeader.slice(6).split(",")[0].trim();

  const [startString, endString] =
    value.split("-");

  let start;
  let end;

  if (startString === "") {
    const suffixLength =
      Number(endString);

    if (
      !Number.isFinite(suffixLength) ||
      suffixLength <= 0
    ) {
      return undefined;
    }

    start = Math.max(
      0,
      size - suffixLength
    );

    end = size - 1;
  } else {
    start = Number(startString);

    if (!Number.isFinite(start) || start < 0) {
      return undefined;
    }

    if (endString === "") {
      end = size - 1;
    } else {
      end = Number(endString);
    }

    if (
      !Number.isFinite(end) ||
      end < start
    ) {
      return undefined;
    }

    end = Math.min(
      end,
      size - 1
    );
  }

  return {
    offset: start,
    length: end - start + 1
  };
}


/* =========================================================
   HELPERS
========================================================= */

function getIdFromPath(pathname, prefix) {
  const value =
    pathname.slice(prefix.length);

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}


function cleanFilename(filename) {
  let value =
    String(filename || "download");

  /*
   * Remove path components.
   */
  value = value
    .replace(/\\/g, "/")
    .split("/")
    .pop();

  /*
   * Remove control characters.
   */
  value = value.replace(
    /[\u0000-\u001F\u007F]/g,
    ""
  );

  value = value.trim();

  if (!value) {
    value = "download";
  }

  /*
   * Keep filenames reasonably sized.
   */
  return value.slice(0, 255);
}


function escapeFilename(filename) {
  return String(filename)
    .replace(/\\/g, "_")
    .replace(/"/g, "_")
    .replace(/\r/g, "_")
    .replace(/\n/g, "_");
}


function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
