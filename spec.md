# SPEC.md — Steelform-agent

## 1. Overview
`Steelform-agent` is a serverless webhook-driven agent hosted on **Vercel** (source in GitHub repo `Steelform-agent`). When an email with a brief project description and up to **3 images** arrives at `projects@<domain>`, Microsoft 365 notifies the agent via **Microsoft Graph change notifications**. The agent fetches the message and image attachments, structures the project metadata, uploads the images to **Sanity**, and creates a `project` document consumed by `Steelform-website`.

## 2. Goals & Non-Goals (Pilot v1)
### Goals
- Receive and validate Microsoft Graph webhook notifications (`validationToken` handshake + `clientState` verification).
- Fetch email subject, body, and image attachments from the target mailbox via Microsoft Graph API.
- Extract structured project fields from the email text (using a free-tier cloud LLM if needed, with deterministic fallback).
- Upload up to 3 image assets to Sanity and create a corresponding `project` document (defaulting to a draft for safe review).
- Provide an automated subscription renewal path so the webhook does not silently expire.

### Non-Goals (Out of Scope for v1)
- Hosting an LLM on a local machine exposed over a tunnel to Vercel.
- Complex multi-turn email threads, approvals over email, or editing/deleting existing Sanity projects.
- Video, CAD, or non-image file processing beyond basic filtering/skipping.

## 3. Architecture & Data Flow
1. **Webhook Receiver (`POST /api/webhooks/graph`)**
   - If `validationToken` query param is present, return `200` (`Content-Type: text/plain`) with the raw `validationToken`.
   - On `POST` notifications, verify `clientState` matches `GRAPH_WEBHOOK_SECRET`; return `202` (or `200`) quickly after validating/queuing work.
2. **Graph Mail & Attachment Fetcher**
   - Authenticate to Microsoft Entra ID using client credentials (`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`).
   - Fetch the target message (`GET /users/{mailbox}/messages/{id}`) and its attachments (`GET /users/{mailbox}/messages/{id}/attachments`).
   - Filter for image attachments (e.g., `image/jpeg`, `image/png`, `image/webp`) and cap/take up to **3 images**.
3. **Content Structuring (LLM / Parser)**
   - Convert email subject + body into clean project fields (`title`, `slug`, `summary`, optional tags/metadata).
   - Keep the LLM call isolated behind a provider-agnostic helper so free-tier cloud models can be swapped or disabled easily.
4. **Sanity Asset & Document Writer**
   - Upload each image buffer via `@sanity/client` (`client.assets.upload('image', buffer, { filename, contentType })`).
   - Create a `project` document in Sanity referencing the uploaded image asset IDs.
   - Prefix document `_id` with `drafts.` during pilot (`DRAFT_BY_DEFAULT=true`) until output quality is verified.
5. **Subscription Manager (`POST` + Scheduled Renewal)**
   - Create subscription for `/users/{mailbox}/mailFolders('Inbox')/messages` (`changeType: "created"`).
   - Periodically `PATCH` `expirationDateTime` before expiry.

## 4. Sanity Schema Mapping (Update With Exact `Steelform-website` Schema)
Map incoming data to your `project` schema in `Steelform-website`:
- `title` (`string`): Derived from email subject or generated title.
- `slug` (`slug`): URL-safe slug generated from `title`.
- `summary` / `description` (`text` or `block` array): Cleaned project brief from email body.
- `images` / `gallery` (`array` of `image` objects): References (`_type: "reference"`, `_ref: asset._id`) for up to 3 uploaded images.
- *(Optional fields from your schema—fill in)*: e.g., `client`, `location`, `category`, `completedAt`, `publishedAt`.

## 5. Proposed Repository Layout (`Steelform-agent`)
```text
├── SPEC.md
├── package.json
├── tsconfig.json
├── next.config.ts
└── src/
    ├── app/
    │   └── api/
    │       ├── webhooks/
    │       │   └── graph/
    │       │       └── route.ts
    │       └── cron/
    │           └── renew-subscription/
    │               └── route.ts
    └── lib/
        ├── config.ts
        ├── graph.ts
        ├── llm.ts
        └── sanity.ts

## 4. Sanity `project` Schema Contract (Steelform)
- Document `_type`: `"project"`
- Required fields:
  - `title`: string
  - `slug`: `{ _type: "slug", current: string }`
  - `publishDate`: ISO datetime string
  - `heroImage`: `imageWithAlt` object referencing uploaded image asset (`_ref`) + `alt` text
  - `solutions`: non-empty array of `{ _key, _type: "reference", _ref }` pointing to `solution` docs where `solutionType == "child"`
- Optional fields:
  - `summary`: string
  - `gallery`: array of `imageWithAlt` items (`{ _key, _type: "reference", _ref, alt }`) for additional photos (up to 3 total photos per email)
  - `industries`: array of `{ _key, _type: "reference", _ref }` (`industry`)
  - `equipmentTypes`: array of `{ _key, _type: "reference", _ref }` (`equipmentType`)



