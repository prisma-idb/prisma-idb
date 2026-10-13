import { GeistSans } from "geist/font/sans";
import { Provider } from "@/components/provider";
import "./global.css";
import { Metadata } from "next";
import { siteName, siteUrl } from "@/lib/seo";

export const metadata: Metadata = {
  title: {
    default: "Prisma IDB — Type-safe IndexedDB for Prisma 8",
    template: "%s | Prisma IDB",
  },
  description: "A typed IndexedDB client for Prisma 8, with versioned migrations and optional bidirectional sync.",
  metadataBase: new URL(siteUrl),
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName,
    title: "Prisma IDB — Type-safe IndexedDB with the Prisma API",
    url: siteUrl,
    description: "A typed IndexedDB client for Prisma 8, with versioned migrations and optional bidirectional sync.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Prisma IDB" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Prisma IDB — Type-safe IndexedDB for Prisma 8",
    description: "A typed IndexedDB client for Prisma 8, with versioned migrations and optional bidirectional sync.",
    images: ["/og.png"],
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={GeistSans.className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
