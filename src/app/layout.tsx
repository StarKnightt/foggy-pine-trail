import type { Metadata } from 'next';
import './globals.css';

/* No `next/font`. It downloads a font file at build time, and this project
 * ships zero external assets — the handful of UI strings use the platform
 * stack. */

export const metadata: Metadata = {
  title: 'Foggy Pine Trail',
  description:
    'A Pacific Northwest pine trail at 6am in dense fog. Every texture, mesh and sound generated in code.',
};

export const viewport = {
  themeColor: '#0b0e0d',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full overflow-hidden bg-black text-white">{children}</body>
    </html>
  );
}
