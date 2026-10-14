import type { Metadata } from "next";
import { Hero } from "./hero";
import { CodeComparison } from "./code-comparison";
import { DemoSection } from "./demo-section";
import { SyncSection } from "./sync-section";
import { ComparisonSection } from "./comparison-section";
import { PerformanceSection } from "./performance-section";
import { QuickInstall } from "./quick-install";
import { Footer } from "./footer";

/** Self-referencing canonical for the root URL; title and description come from the root layout. */
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <Hero />
      <CodeComparison />
      <DemoSection />
      <SyncSection />
      <ComparisonSection />
      <PerformanceSection />
      <QuickInstall />
      <Footer />
    </div>
  );
}
