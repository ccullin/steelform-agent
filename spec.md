# SPEC.md — Steelform-agent

## 1. Overview
`Steelform-agent` This project is a serverless webhook-driven agent hosted on **Vercel** (Next.js App Router, source in GitHub repo `Steelform-agent`). When an email with a project description and image(s) arrives at the target mailbox (`agent@steelformengineering.com.au`, Microsoft 365 notifies the agent via **Microsoft Graph change notifications**. The agent fetches the message and image attachments, queries existing Sanity taxonomy, uses **Gemini** with structured JSON output to map project fields, ensures unique slugs and valid references, uploads image assets to **Sanity** (`pf2xnwzy`), and creates a `project` document consumed by `Steelform-website`.

## 2. Goals & Non-Goals (Pilot v1)
### Goals
- Receive and validate Microsoft Graph webhook notifications (`validationToken` handshake + `clientState` verification)[cite: 3].
- Fetch email subject, body, timestamps, and image attachments from the target mailbox via Microsoft Graph API[cite: 3].
- Keep real-time push active via periodic subscription renewal (every ~24–36 hours, well within Microsoft Graph's ~48-hour / short-lived mail subscription window) with fallback re-registration if a subscription expires.
- Query Sanity for existing `solution` (`solutionType == "child"`), `industry`, and `equipmentType` documents to ground LLM selection.
- Use Gemini structured output (`responseSchema`) to generate schema-compliant JSON from the email content.
- Create a new `equipmentType` document in Sanity if the email specifies an equipment type that does not already exist in Sanity.
- Slugify the project `title` deterministically and check existing Sanity project slugs to guarantee uniqueness before writing.
- Upload image assets to Sanity and create a `project` document (`heroImage` required via `imageWithAlt`, plus optional `gallery` up to 3 total images).

### Implementtion Considerations
- retry behaviour may be required for api calls that fail
- webhooks for new emails may be missed or duplicated and this needs to be handles
- a log of processed emails needs to be maintained, perhaps stored as a sanity document
- determine if any email should be processes upfront, i.e. skip if its not the correct shape
- include logic to select the best HeroImage from the included images
- include logic to prepare a title, image alt text, and a sumamry of the project from the text and impages provided

### Non-Goals (Out of Scope for v1)
- Relying on a once-a-week registration/renewal schedule (subscriptions expire before 7 days and do not retroactively emit missed message webhooks).
- Hosting an LLM on a local machine exposed over a tunnel to Vercel[cite: 3].
- Complex multi-turn email threads, approvals over email, or editing/deleting existing Sanity projects (other than creating new `equipmentType` records when needed).
- Video, CAD, or non-image file processing beyond basic filtering/skipping.

## 3. Architecture & Data Flow
1. **Webhook Receiver (`src/app/api/webhooks/graph/route.ts`)**
   - If `validationToken` query param is present, return `200` (`Content-Type: text/plain`) with the raw `validationToken`[cite: 3].
   - On `POST` notifications, verify `clientState` matches the configured webhook secret (`steelform-test-secret` / `GRAPH_WEBHOOK_SECRET`), validate message IDs (rejecting malformed IDs early), and process/respond cleanly[cite: 3].
2. **Graph Mail & Attachment Fetcher**
   - Authenticate to Microsoft Entra ID using client credentials (`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`.
   - Fetch the target message (`GET /users/{mailbox}/messages/{id}`) and its attachments (`GET /users/{mailbox}/messages/{id}/attachments`).
   - Extract image attachments (e.g., `image/jpeg`, `image/png`, `image/webp`) and enforce at least one image for `heroImage` (up to **3 images** total across `heroImage` and `gallery`).
3. **Sanity Taxonomy Lookup & Dynamic Equipment Creation**
   - Query Sanity for existing reference candidates:
     - Child solutions: `*[_type == "solution" && solutionType == "child"]`
     - Industries: `*[_type == "industry"]`
     - Equipment types: `*[_type == "equipmentType"]`[cite: 2]
   - Pass the available IDs and titles/names to Gemini so references map to real Sanity documents[cite: 2].
   - If Gemini identifies a new equipment type not present in existing `equipmentType` records, create the new `equipmentType` document in Sanity (with deduplication/unique slug) and include its reference in `equipmentTypes`[cite: 2].
4. **Content Structuring via Gemini (`responseSchema`)**
   - Use `@google/genai` with `responseMimeType: "application/json"` and an explicit `responseSchema` to convert email subject, body, and attachment context into structured project fields[cite: 3].
   - Validate and sanitize all extracted fields and reference IDs in TypeScript before writing to Sanity so invalid IDs or empty required arrays cannot violate the schema.
5. **Deterministic Slug Generation & Uniqueness Check**
   - Generate a base slug from `title` (`slugify(title)`).
   - Query Sanity for existing `project` documents matching the slug/prefix (`slug.current == $slug` or `slug.current match "${base}*"`) across the dataset.
   - If a collision exists, append a numeric suffix (`-2`, `-3`, etc.) until a unique `slug.current` is found before creating the document.
6. **Sanity Asset & Document Writer**
   - Upload image buffers via `@sanity/client` (`client.assets.upload('image', buffer, { filename, contentType })`)[cite: 3].
   - Populate `heroImage` as an `imageWithAlt` object (`image` asset reference + `alt` text) and optional `gallery` items (`imageWithAlt`)[cite: 1, 2].
   - Populate required `solutions` (at least one reference to a `child` solution) and optional `industries` and `equipmentTypes` references, each with a unique `_key`[cite: 2].
   - Support publishing directly or creating drafts depending on environment configuration (`DRAFT_BY_DEFAULT`)[cite: 3].
7. **Subscription Manager (`POST` + Scheduled Renewal)**
   - Register subscription for `/users/{mailbox}/mailFolders('Inbox')/messages` (`changeType: "created"`) with `clientState`[cite: 3].
   - Run a scheduled renewal job every **24–36 hours** (ahead of the ~48-hour renewal window) to `PATCH` `expirationDateTime` on the active subscription, falling back to `POST` re-registration if expired/missing[cite: 3].

## 4. Sanity `project` & `imageWithAlt` Schema Contract
- **Document `_type`**: `"project"`[cite: 2]
- **Required fields**:
  - `title` (`string`): Project title derived from email content[cite: 2].
  - `slug` (`slug` -> `{ _type: "slug", current: string }`): Unique slug derived from `slugify(title)` after checking existing Sanity slugs[cite: 2].
  - `publishDate` (`datetime` -> ISO string): Timestamp from the email (`receivedDateTime`) or current ISO timestamp[cite: 2].
  - `heroImage` (`imageWithAlt` -> `{ _type: "imageWithAlt", image: { _type: "image", asset: { _type: "reference", _ref: string } }, alt?: string }`): Primary image asset + alt text (requires at least one image in the email)[cite: 1, 2].
  - `solutions` (`array` of `reference` -> non-empty array of `{ _key, _type: "reference", _ref }`): Must contain at least 1 reference to a `solution` document where `solutionType == "child"`[cite: 2].
- **Optional fields**:
  - `summary` (`text` -> `string`): Concise project overview/scope extracted from the email[cite: 2].
  - `gallery` (`array` of `imageWithAlt` -> `{ _key, _type: "imageWithAlt", image: ..., alt?: string }`): Additional project images (up to 3 total images per email)[cite: 1, 2, 3].
  - `industries` (`array` of `reference` -> `{ _key, _type: "reference", _ref }`): Zero or more references to existing `industry` documents[cite: 2].
  - `equipmentTypes` (`array` of `reference` -> `{ _key, _type: "reference", _ref }`): Zero or more references to `equipmentType` documents (existing or newly created in Sanity)[cite: 2].

## 5. Local & Production Operational Notes
- **Local dev ports:** When port `3000` is occupied by another process, `next dev` automatically binds to the next available port (such as `3001`), so local webhook tests should target the active port (`http://localhost:3001/api/webhooks/graph`) or pass `-p` / `PORT` explicitly.
- **Environment variables:** Configure Microsoft Graph credentials (`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TARGET_MAILBOX`, `GRAPH_WEBHOOK_SECRET`), Sanity credentials (`NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET`, `SANITY_API_WRITE_TOKEN`), `GEMINI_API_KEY`, and cron auth (`CRON_SECRET`) in `.env.local` and Vercel environment settings[cite: 3].

## 6. Proposed Repository Layout (`Steelform-agent`)
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
    |   ├── config.ts
    |   ├── graph.ts
    |   ├── gemini.ts
    |   ├── slug.ts
    |   └── sanity.ts
    |
    |
    └── website-schema-ref/
    |   ├── arthicle-schema.ts
    |   ├── equipmentTyeSchema.ts
    |   ├── generalPageSchema.ts
    |   ├── globalSettingsSchema.ts
    |   └── imageWithAltSchema.ts  
    |   └── industrySchema.ts  
    |   └── projectSchema.ts  
    |   └── seoSchema.ts  
    |   └── solutionSchema.ts  