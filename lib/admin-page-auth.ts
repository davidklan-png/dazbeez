const ADMIN_REALM = "Dazbeez Admin";
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type AdminPageCredentials = {
  username: string;
  password: string;
};

function getConfiguredAdminPageCredentials(): AdminPageCredentials | null {
  const username = process.env.ADMIN_PAGE_USERNAME?.trim();
  const password = process.env.ADMIN_PAGE_PASSWORD;

  if (!username || !password) {
    return null;
  }

  return { username, password };
}

function safeEqual(left: string, right: string) {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;

  for (let i = 0; i < length; i += 1) {
    mismatch |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }

  return mismatch === 0;
}

function decodeBase64(encoded: string) {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return textDecoder.decode(bytes);
}

function decodeBasicAuthorization(value: string | null) {
  if (!value?.startsWith("Basic ")) {
    return null;
  }

  const encoded = value.slice(6).trim();

  if (!encoded) {
    return null;
  }

  try {
    const decoded = decodeBase64(encoded);
    const separator = decoded.indexOf(":");

    if (separator <= 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function getAdminPageUsernameFromHeaders(requestHeaders: Headers) {
  const provided = decodeBasicAuthorization(requestHeaders.get("authorization"));
  return provided?.username ?? null;
}

export function isAdminPageAuthConfigured() {
  return getConfiguredAdminPageCredentials() !== null;
}

export function getAdminPageAuthChallengeHeaders() {
  return {
    "WWW-Authenticate": `Basic realm="${ADMIN_REALM}", charset="UTF-8"`,
  };
}

export function isAdminPageAuthorized(requestHeaders: Headers) {
  const configured = getConfiguredAdminPageCredentials();
  const provided = decodeBasicAuthorization(requestHeaders.get("authorization"));

  if (!configured || !provided) {
    return false;
  }

  return (
    safeEqual(provided.username, configured.username) &&
    safeEqual(provided.password, configured.password)
  );
}

export function assertAdminPageAccessFromHeaders(requestHeaders: Headers) {
  if (!isAdminPageAuthorized(requestHeaders)) {
    throw new Error("Unauthorized admin request.");
  }
}
