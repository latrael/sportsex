import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const url = process.env.DATABASE_URL ?? '';
  return NextResponse.json({
    db_set: url.length > 0,
    db_starts_with: url.slice(0, 25),
    auth_secret_set: (process.env.AUTH_SECRET ?? '').length > 0,
    node_env: process.env.NODE_ENV,
  });
}
