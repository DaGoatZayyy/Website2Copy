import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Site Archiver", description: "Archive publicly accessible website pages and assets into a ZIP." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
