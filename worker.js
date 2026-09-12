const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const SESSION_COOKIE = "quickdrop_session";

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers(JSON_HEADERS);

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function makeId() {
  return crypto.randomUUID();
}

function itemKey(id) {
  return `items/${id}.json`;
}

function fileKey(id) {
  return `files/${id}`;
}

function safeFilename(name) {
  return (name || "file")
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "file";
}

function base64Url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function stringToBytes(value) {
  return new TextEncoder().encode(value);
}

async function sha256(value) {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      stringToBytes(value)
    )
  );
}

async function createSessionToken(password) {
  const digest = await sha256(
    `quickdrop-session:${password}`
  );

  return base64Url(digest);
}

async function passwordMatches(input, actual) {
  if (!actual) return false;

  const a = await sha256(input);
  const b = await sha256(actual);

  if (a.length !== b.length) return false;

  let difference = 0;

  for (let i = 0; i < a.length; i++) {
    difference |= a[i] ^ b[i];
  }

  return difference === 0;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");

    if (separator === -1) continue;

    const key = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();

    if (key === name) {
      return value;
    }
  }

  return null;
}

async function isAuthenticated(request, env) {
  // No password configured = public access.
  if (!env.QUICKDROP_PASSWORD) {
    return true;
  }

  const cookie = getCookie(request, SESSION_COOKIE);

  if (!cookie) {
    return false;
  }

  const expected = await createSessionToken(
    env.QUICKDROP_PASSWORD
  );

  return cookie === expected;
}

async function requireAuth(request, env) {
  if (await isAuthenticated(request, env)) {
    return null;
  }

  return json(
    {
      error: "Authentication required.",
      authenticated: false
    },
    401
  );
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
  const items = [];
  let cursor;

  do {
    const result = await env.QUICKDROP.list({
      prefix: "items/",
      limit: 1000,
      cursor
    });

    for (const object of result.objects) {
      const stored = await env.QUICKDROP.get(object.key);

      if (!stored) continue;

      try {
        items.push(await stored.json());
      } catch {
        // Ignore invalid metadata objects.
      }
    }

    cursor = result.truncated
      ? result.cursor
      : undefined;
  } while (cursor);

  items.sort((a, b) => {
    return (
      new Date(b.createdAt).getTime() -
      new Date(a.createdAt).getTime()
    );
  });

  return items;
}

async function deleteAllObjects(env) {
  let cursor;
  let deleted = 0;

  do {
    const result = await env.QUICKDROP.list({
      limit: 1000,
      cursor
    });

    const keys = result.objects.map(
      object => object.key
    );

    if (keys.length) {
      await env.QUICKDROP.delete(keys);
      deleted += keys.length;
    }

    cursor = result.truncated
      ? result.cursor
      : undefined;
  } while (cursor);

  return deleted;
}

async function handleAuth(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/api/auth/status") {
    const passwordEnabled = Boolean(
      env.QUICKDROP_PASSWORD
    );

    const authenticated = await isAuthenticated(
      request,
      env
    );

    return json({
      passwordEnabled,
      authenticated
    });
  }

  if (
    url.pathname === "/api/auth/login" &&
    request.method === "POST"
  ) {
    if (!env.QUICKDROP_PASSWORD) {
      return json({
        passwordEnabled: false,
        authenticated: true
      });
    }

    const body = await request.json().catch(() => null);

    const password =
      body && typeof body.password === "string"
        ? body.password
        : "";

    if (
      !(await passwordMatches(
        password,
        env.QUICKDROP_PASSWORD
      ))
    ) {
      return json(
        {
          error: "Incorrect password."
        },
        401
      );
    }

    const token = await createSessionToken(
      env.QUICKDROP_PASSWORD
    );

    return json(
      {
        success: true,
        authenticated: true
      },
      200,
      {
        "Set-Cookie":
          `${SESSION_COOKIE}=${token}; ` +
          "Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000"
      }
    );
  }

  if (
    url.pathname === "/api/auth/logout" &&
    request.method === "POST"
  ) {
    return json(
      {
        success: true
      },
      200,
      {
        "Set-Cookie":
          `${SESSION_COOKIE}=; ` +
          "Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
      }
    );
  }

  return null;
}

async function handleApi(request, env) {
  const url = new URL(request.url);

  // Authentication endpoints must be available
  // before normal API authentication.
  const authResponse = await handleAuth(
    request,
    env
  );

  if (authResponse) {
    return authResponse;
  }

  const protectedResponse = await requireAuth(
    request,
    env
  );

  if (protectedResponse) {
    return protectedResponse;
  }

  if (
    url.pathname === "/api/items" &&
    request.method === "GET"
  ) {
    const items = await listItems(env);

    return json({
      items
    });
  }

  if (
    url.pathname === "/api/text" &&
    request.method === "POST"
  ) {
    const body = await request.json().catch(() => null);

    if (
      !body ||
      typeof body.text !== "string"
    ) {
      return json(
        {
          error: "Invalid text."
        },
        400
      );
    }

    const text = body.text.trim();

    if (!text) {
      return json(
        {
          error: "Text cannot be empty."
        },
        400
      );
    }

    if (text.length > 500000) {
      return json(
        {
          error: "Text is too large."
        },
        413
      );
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
          contentType:
            "application/json"
        }
      }
    );

    return json(
      {
        item
      },
      201
    );
  }

  if (
    url.pathname === "/api/upload" &&
    request.method === "POST"
  ) {
    const contentLength = Number(
      request.headers.get("Content-Length") || 0
    );

    if (
      contentLength &&
      contentLength > 100 * 1024 * 1024
    ) {
      return json(
        {
          error:
            "Files are limited to 100 MB."
        },
        413
      );
    }

    const id = makeId();

    const originalName =
      request.headers.get("X-File-Name") ||
      "file";

    const name =
      safeFilename(originalName);

    const mimeType =
      request.headers.get("Content-Type") ||
      "application/octet-stream";

    const key = fileKey(id);

    if (!request.body) {
      return json(
        {
          error: "No file data received."
        },
        400
      );
    }

    await env.QUICKDROP.put(
      key,
      request.body,
      {
        httpMetadata: {
          contentType: mimeType,
          contentDisposition:
            `inline; filename="${name.replace(
              /"/g,
              ""
            )}"`
        },
        customMetadata: {
          originalName: name
        }
      }
    );

    const item = {
      id,
      type: "file",
      name,
      size: contentLength || 0,
      mimeType,
      createdAt: new Date().toISOString()
    };

    await env.QUICKDROP.put(
      itemKey(id),
      JSON.stringify(item),
      {
        httpMetadata: {
          contentType:
            "application/json"
        }
      }
    );

    return json(
      {
        item
      },
      201
    );
  }

  if (
    url.pathname.startsWith("/api/file/") &&
    request.method === "GET"
  ) {
    const id =
      url.pathname.split("/").pop();

    if (!id) {
      return new Response(
        "File not found.",
        { status: 404 }
      );
    }

    const item = await getItem(
      env,
      id
    );

    if (
      !item ||
      item.type !== "file"
    ) {
      return new Response(
        "File not found.",
        { status: 404 }
      );
    }

    const object =
      await env.QUICKDROP.get(
        fileKey(id)
      );

    if (!object) {
      return new Response(
        "File not found.",
        { status: 404 }
      );
    }

    const headers = new Headers();

    object.writeHttpMetadata(
      headers
    );

    headers.set(
      "ETag",
      object.httpEtag
    );

    headers.set(
      "Cache-Control",
      "private, max-age=3600"
    );

    return new Response(
      object.body,
      {
        headers
      }
    );
  }

  if (
    url.pathname.startsWith("/api/items/") &&
    request.method === "DELETE"
  ) {
    const id =
      url.pathname.split("/").pop();

    if (!id) {
      return json(
        {
          error: "Missing item ID."
        },
        400
      );
    }

    const item =
      await getItem(env, id);

    if (!item) {
      return json(
        {
          error: "Item not found."
        },
        404
      );
    }

    await env.QUICKDROP.delete(
      itemKey(id)
    );

    if (item.type === "file") {
      await env.QUICKDROP.delete(
        fileKey(id)
      );
    }

    return json({
      success: true
    });
  }

  if (
    url.pathname === "/api/delete-all" &&
    request.method === "DELETE"
  ) {
    const deleted =
      await deleteAllObjects(env);

    return json({
      success: true,
      deleted
    });
  }

  return json(
    {
      error:
        "API endpoint not found."
    },
    404
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(
      request.url
    );

    try {
      // API
      if (
        url.pathname.startsWith("/api/")
      ) {
        return await handleApi(
          request,
          env
        );
      }

      // If a password exists, protect
      // the actual website too.
      if (
        env.QUICKDROP_PASSWORD &&
        !(await isAuthenticated(
          request,
          env
        ))
      ) {
        return new Response(
          `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QuickDrop</title>
</head>
<body>
<script>
window.location.href =
  "/?login=required";
</script>
</body>
</html>`,
          {
            headers: {
              "Content-Type":
                "text/html; charset=utf-8",
              "Cache-Control":
                "no-store"
            }
          }
        );
      }

      return env.ASSETS.fetch(
        request
      );
    } catch (error) {
      console.error(error);

      return json(
        {
          error:
            "Internal server error."
        },
        500
      );
    }
  }
};
