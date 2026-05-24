import { NextResponse } from 'next/server';

export function POST(): NextResponse {
  return NextResponse.json({ status: 'received' });
}
