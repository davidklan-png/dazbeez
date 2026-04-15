import { timingSafeEqual } from "node:crypto";

const ADMIN_REALM = "Dazbeez Admin";

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
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
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
