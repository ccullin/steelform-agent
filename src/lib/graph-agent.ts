import { createProjectInSanity, IncomingImage } from './sanity'

interface GraphNotificationPayload {
  value?: Array<{
    subscriptionId?: string
    clientState?: string
    changeType?: string
    resource?: string
    resourceData?: {
      id?: string
    }
  }>
}

interface GraphMessage {
  id: string
  subject?: string
  receivedDateTime?: string
  body?: {
    contentType?: 'text' | 'html'
    content?: string
  }
}

interface GraphAttachment {
  '@odata.type'?: string
  id: string
  name?: string
  contentType?: string
  contentBytes?: string
  isInline?: boolean
}

async function getGraphAccessToken(): Promise<string> {
  const tenantId = process.env.MS_TENANT_ID!
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`

  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID!,
    client_secret: process.env.MS_CLIENT_SECRET!,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  })

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!res.ok) {
    throw new Error(`Entra token request failed (${res.status}): ${await res.text()}`)
  }

  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTitleAndSummary(message: GraphMessage) {
  const rawBody = message.body?.content || ''
  const plainText =
    message.body?.contentType === 'html' ? stripHtml(rawBody) : rawBody.replace(/\s+/g, ' ').trim()

  const title = (message.subject || '').trim() || plainText.slice(0, 80) || 'New Project'
  const summary = plainText.slice(0, 1000)

  return { title, summary }
}

async function fetchImageAttachments(
  token: string,
  mailbox: string,
  messageId: string
): Promise<IncomingImage[]> {
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    throw new Error(`Graph attachments fetch failed (${res.status}): ${await res.text()}`)
  }

  const data = (await res.json()) as { value?: GraphAttachment[] }
  const attachments = data.value ?? []

  const images: IncomingImage[] = []

  for (const att of attachments) {
    if (images.length >= 3) break
    const isFileAttachment = att['@odata.type'] === '#microsoft.graph.fileAttachment'
    const mime = (att.contentType || '').toLowerCase()

    // Skip inline signature pixels/icons unless needed, keep standard image types
    if (!isFileAttachment || !mime.startsWith('image/') || !att.contentBytes) {
      continue
    }

    const buffer = Buffer.from(att.contentBytes, 'base64')
    // Filter out tiny tracking/logo artifacts under 10KB if desired
    if (buffer.length < 10_000 && att.isInline) {
      continue
    }

    images.push({
      filename: att.name || `photo-${images.length + 1}.jpg`,
      contentType: mime,
      buffer,
    })
  }

  return images
}

export async function processGraphNotifications(payload: GraphNotificationPayload) {
  const expectedSecret = process.env.GRAPH_WEBHOOK_SECRET
  const mailbox = process.env.MS_TARGET_MAILBOX!
  const asDraft = process.env.DRAFT_BY_DEFAULT !== 'false'

  const notifications = payload.value ?? []
  if (notifications.length === 0) return []

  const token = await getGraphAccessToken()
  const results = []

  for (const item of notifications) {
    if (expectedSecret && item.clientState !== expectedSecret) {
      throw new Error('Invalid clientState on Graph notification')
    }

    const messageId =
      item.resourceData?.id || item.resource?.split('/').filter(Boolean).pop()

    if (!messageId) continue

    const msgRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=id,subject,receivedDateTime,body`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    )

    if (!msgRes.ok) {
      throw new Error(`Graph message fetch failed (${msgRes.status}): ${await msgRes.text()}`)
    }

    const message = (await msgRes.json()) as GraphMessage
    const { title, summary } = extractTitleAndSummary(message)
    const images = await fetchImageAttachments(token, mailbox, messageId)

    const result = await createProjectInSanity({
      sourceMessageId: message.id,
      title,
      summary,
      publishDate: message.receivedDateTime,
      images,
      asDraft,
    })

    results.push({ messageId: message.id, ...result })
  }

  return results
}
