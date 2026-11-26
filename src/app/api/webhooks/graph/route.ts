import { NextRequest, NextResponse } from 'next/server'
import { processGraphNotifications } from '@/lib/graph-agent'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const validationToken = req.nextUrl.searchParams.get('validationToken')
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return NextResponse.json({ ok: true })
}

export async function POST(req: NextRequest) {
  const validationToken = req.nextUrl.searchParams.get('validationToken')
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  try {
    const body = await req.json()
    const processed = await processGraphNotifications(body)
    return NextResponse.json({ ok: true, processed }, { status: 202 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const status = message.includes('Invalid clientState') ? 401 : 500
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
