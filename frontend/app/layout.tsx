import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Commander - Control all your apps with voice",
  description: "Voice-first platform to control Google Calendar, Slack, Notion, and more through natural speech commands",
  keywords: ["voice control", "voice assistant", "productivity", "automation", "voice commands"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
