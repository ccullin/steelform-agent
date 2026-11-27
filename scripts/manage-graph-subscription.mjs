import fs from "node:fs";

for (const file of [".env", ".env.local"]) {
  if (fs.existsSync(file)) {
    process.loadEnvFile(file);
  }
}

const {
  MS_TENANT_ID,
  GRAPH_TENANT_ID,
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MS_TARGET_MAILBOX,
  GRAPH_WEBHOOK_SECRET,
  GRAPH_WEBHOOK_URL,
  GRAPH_SUBSCRIPTION_ID,
} = process.env;

const tenantId = MS_TENANT_ID || GRAPH_TENANT_ID;

const requiredVars = {
  MS_TENANT_ID: tenantId,
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MS_TARGET_MAILBOX,
  GRAPH_WEBHOOK_SECRET,
  GRAPH_WEBHOOK_URL,
};

for (const [name, value] of Object.entries(requiredVars)) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

async function getAccessToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: MS_CLIENT_ID,
        client_secret: MS_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function run() {
  const token = await getAccessToken();
  const expirationDateTime = new Date(
    Date.now() + 48 * 60 * 60 * 1000
  ).toISOString();

  if (GRAPH_SUBSCRIPTION_ID) {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/subscriptions/${GRAPH_SUBSCRIPTION_ID}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expirationDateTime }),
      }
    );

    if (!res.ok) {
      throw new Error(`Renewal failed (${res.status}): ${await res.text()}`);
    }

    const updated = await res.json();
    console.log("Renewed subscription:", {
      id: updated.id,
      expirationDateTime: updated.expirationDateTime,
    });
    return;
  }

  const res = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl: GRAPH_WEBHOOK_URL,
      resource: `users/${MS_TARGET_MAILBOX}/messages`,
      expirationDateTime,
      clientState: GRAPH_WEBHOOK_SECRET,
    }),
  });

  if (!res.ok) {
    throw new Error(`Creation failed (${res.status}): ${await res.text()}`);
  }

  const created = await res.json();
  console.log("Created subscription:", {
    id: created.id,
    expirationDateTime: created.expirationDateTime,
  });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});