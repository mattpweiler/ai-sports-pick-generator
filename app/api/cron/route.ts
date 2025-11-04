import { NextResponse } from 'next/server';

export async function GET() {
  console.log('test cron job')
  return NextResponse.json({ ok: true });
}