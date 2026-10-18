import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "LLM Chat",
  description: "Aplikasi chat LLM sederhana dengan API key gratis",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
