import { GeistSans } from "geist/font/sans";
import { Provider } from "@/components/provider";
import "./global.css";
import { Metadata } from "next";
import { siteName, siteUrl } from "@/lib/seo";

export const metadata: Metadata = {
  title: {
    default: "Prisma IDB — Type-safe IndexedDB with the Prisma API",
    template: "%s | Prisma IDB",
  },
  description:
    "A Prisma generator that creates a type-safe IndexedDB client with the API you already know — plus optional bidirectional sync with conflict resolution.",
  metadataBase: new URL(siteUrl),
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName,
    title: "Prisma IDB — Type-safe IndexedDB with the Prisma API",
    description:
      "A Prisma generator that creates a type-safe IndexedDB client with the API you already know — plus optional bidirectional sync.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Prisma IDB" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Prisma IDB — Type-safe IndexedDB with the Prisma API",
    description:
      "A Prisma generator that creates a type-safe IndexedDB client with the API you already know — plus optional bidirectional sync.",
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
