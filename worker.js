const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function makeId() {
  return crypto.randomUUID();
}

function safeFilename(name) {
  return (name || "file")
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "file";
}

function itemKey(id) {
  return `items/${id}.json`;
}

function fileKey(id) {
  return `files/${id}`;
}

async function getItem(env, id) {
  const object = await env.QUICKDROP.get(itemKey(id));

  if (!object) {
    return null;
  }

  try {
    return await object.json();
  } catch {
    return null;
  }
}

async function listItems(env) {
  const result = await env.QUICKDROP.list({
    prefix: "items/",
    limit: 1000
  });

  const items = [];

  for (const object of result.objects) {
    const stored = await env.QUICKDROP.get(object.key);

    if (!stored) continue;

    try {
      items.push(await stored.json());
    } catch {
      // Ignore invalid objects.
    }
  }

  items.sort((a, b) => {
    return new Date(b.createdAt).getTime() -
           new Date(a.createdAt).getTime();
  });

  return items;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/items" && request.method === "GET") {
    const items = await listItems(env);
    return json({ items });
  }

  if (path === "/api/text" && request.method === "POST") {
    const body = await request.json().catch(() => null);

    if (!body || typeof body.text !== "string") {
      return json({ error: "Invalid text." }, 400);
    }

    const text = body.text.trim();

    if (!text) {
      return json({ error: "Text cannot be empty." }, 400);
    }

    if (text.length > 500000) {
      return json({ error: "Text is too large." }, 413);
    }

    const id = makeId();

    const item = {
      id,
      type: "text",
      name: "Text",
      text,
      size: new Blob([text]).size,
      createdAt: new Date().toISOString()
    };

    await env.QUICKDROP.put(
      itemKey(id),
      JSON.stringify(item),
      {
        httpMetadata: {
          contentType: "application/json"
        }
      }
    );

    return json({ item }, 201);
  }

  if (path === "/api/upload" && request.method === "POST") {
    const form = await request.formData();

    const file = form.get("file");

    if (!(file instanceof File)) {
      return json({ error: "No file received." }, 400);
    }

    if (file.size > 100 * 1024 * 1024) {
      return json({
        error: "Files are limited to 100 MB on the current setup."
      }, 413);
    }

    const id = makeId();
    const name = safeFilename(file.name);
    const key = fileKey(id);

    await env.QUICKDROP.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
        contentDisposition: `inline; filename="${name.replace(/"/g, "")}"`
      },
      customMetadata: {
        originalName: name
      }
    });

    const item = {
      id,
      type: "file",
      name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      createdAt: new Date().toISOString()
    };

    await env.QUICKDROP.put(
      itemKey(id),
      JSON.stringify(item),
      {
        httpMetadata: {
          contentType: "application/json"
        }
      }
    );

    return json({ item }, 201);
  }

  if (path.startsWith("/api/file/") && request.method === "GET") {
    const id = path.split("/").pop();

    if (!id) {
      return json({ error: "Missing file ID." }, 400);
    }

    const item = await getItem(env, id);

    if (!item || item.type !== "file") {
      return new Response("File not found.", { status: 404 });
    }

    const object = await env.QUICKDROP.get(fileKey(id));

    if (!object) {
      return new Response("File not found.", { status: 404 });
    }

    const headers = new Headers();

    object.writeHttpMetadata(headers);

    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", "private, max-age=3600");

    return new Response(object.body, { headers });
  }

  if (path.startsWith("/api/items/") && request.method === "DELETE") {
    const id = path.split("/").pop();

    if (!id) {
      return json({ error: "Missing item ID." }, 400);
    }

    const item = await getItem(env, id);

    if (!item) {
      return json({ error: "Item not found." }, 404);
    }

    const keys = [itemKey(id)];

    if (item.type === "file") {
      keys.push(fileKey(id));
    }

    await env.QUICKDROP.delete(keys);

    return json({ success: true });
  }

  if (path === "/api/delete-all" && request.method === "DELETE") {
    const result = await env.QUICKDROP.list({
      limit: 1000
    });

    const keys = result.objects.map(object => object.key);

    if (keys.length > 0) {
      await env.QUICKDROP.delete(keys);
    }

    return json({
      success: true,
      deleted: keys.length
    });
  }

  return json({ error: "API endpoint not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (error) {
        console.error(error);

        return json({
          error: "Something went wrong on the server."
        }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
