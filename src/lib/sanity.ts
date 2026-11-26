import { createClient } from '@sanity/client'

export const sanityClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID!,
  dataset: process.env.SANITY_DATASET || 'production',
  apiVersion: '2026-03-01',
  token: process.env.SANITY_API_TOKEN!,
  useCdn: false,
})

export interface IncomingImage {
  filename: string
  contentType: string
  buffer: Buffer
  alt?: string
}

export interface CreateProjectInput {
  sourceMessageId: string
  title: string
  summary: string
  publishDate?: string
  images: IncomingImage[] // Up to 3 images
  solutionIds?: string[]
  industryIds?: string[]
  equipmentTypeIds?: string[]
  asDraft?: boolean
}

function toSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || `project-${Date.now()}`
  )
}

function makeKey(prefix: string, index: number): string {
  return `${prefix}-${index}-${Math.random().toString(36).slice(2, 8)}`
}

async function resolveChildSolutionIds(requestedIds?: string[]): Promise<string[]> {
  if (requestedIds && requestedIds.length > 0) {
    // Verify requested IDs actually belong to child solutions
    const validIds = await sanityClient.fetch<string[]>(
      `*[_type == "solution" && solutionType == "child" && _id in $ids]._id`,
      { ids: requestedIds }
    )
    if (validIds.length > 0) return validIds
  }

  // Optional configured fallback child solution ID for pilot drafts
  if (process.env.DEFAULT_CHILD_SOLUTION_ID) {
    return [process.env.DEFAULT_CHILD_SOLUTION_ID]
  }

  // Fallback to first available child solution in Sanity so draft creation succeeds
  const firstChildId = await sanityClient.fetch<string | null>(
    `*[_type == "solution" && solutionType == "child"] | order(_createdAt asc)[0]._id`
  )

  if (!firstChildId) {
    throw new Error(
      'No child solution found in Sanity (solutionType == "child"). Set DEFAULT_CHILD_SOLUTION_ID or create one first.'
    )
  }

  return [firstChildId]
}

export async function createProjectInSanity(input: CreateProjectInput) {
  const cappedImages = input.images.slice(0, 3)
  if (cappedImages.length === 0) {
    throw new Error('At least one image is required to populate heroImage.')
  }

  // Idempotency guard: avoid duplicating a project for the same email message
  const existingId = await sanityClient.fetch<string | null>(
    `*[_type == "project" && sourceMessageId == $msgId][0]._id`,
    { msgId: input.sourceMessageId }
  )
  if (existingId) {
    return { documentId: existingId, skippedDuplicate: true }
  }

  // Upload images in parallel
  const uploadedAssets = await Promise.all(
    cappedImages.map(async (img, idx) => {
      const asset = await sanityClient.assets.upload('image', img.buffer, {
        filename: img.filename || `project-image-${idx + 1}.jpg`,
        contentType: img.contentType || 'image/jpeg',
      })
      return {
        assetId: asset._id,
        alt: img.alt?.trim() || `${input.title} photo ${idx + 1}`,
      }
    })
  )

  const [heroAsset, ...galleryAssets] = uploadedAssets
  const resolvedSolutionIds = await resolveChildSolutionIds(input.solutionIds)

  const baseId = `project-${input.sourceMessageId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-32) || Date.now()}`
  const docId = input.asDraft ? `drafts.${baseId}` : baseId

  const doc = {
    _id: docId,
    _type: 'project' as const,
    sourceMessageId: input.sourceMessageId,
    title: input.title.trim(),
    slug: {
      _type: 'slug' as const,
      current: toSlug(input.title),
    },
    publishDate: input.publishDate || new Date().toISOString(),
    heroImage: {
      _type: 'imageWithAlt',
      asset: {
        _type: 'reference',
        _ref: heroAsset.assetId,
      },
      alt: heroAsset.alt,
    },
    gallery: galleryAssets.map((item, index) => ({
      _key: makeKey('gal', index),
      _type: 'imageWithAlt',
      asset: {
        _type: 'reference',
        _ref: item.assetId,
      },
      alt: item.alt,
    })),
    summary: input.summary.trim(),
    solutions: resolvedSolutionIds.map((id, index) => ({
      _key: makeKey('sol', index),
      _type: 'reference',
      _ref: id,
    })),
    industries: (input.industryIds ?? []).map((id, index) => ({
      _key: makeKey('ind', index),
      _type: 'reference',
      _ref: id,
    })),
    equipmentTypes: (input.equipmentTypeIds ?? []).map((id, index) => ({
      _key: makeKey('eqp', index),
      _type: 'reference',
      _ref: id,
    })),
  }

  const created = await sanityClient.createOrReplace(doc)
  return { documentId: created._id, skippedDuplicate: false }
}
