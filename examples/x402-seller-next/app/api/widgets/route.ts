import { NextResponse } from 'next/server';

export function GET(): NextResponse {
  return NextResponse.json({ widgets: [1, 2, 3] });
}
