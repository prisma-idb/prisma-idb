import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { Rocket, GitBranch } from "lucide-react";
import { DemoPlayer } from "./demo-player";

export function DemoSection() {
  return (
    <section className="px-6 py-16 sm:py-24 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="text-center">
          <h2 className={`${GeistSans.className} text-fd-foreground text-3xl font-bold sm:text-4xl`}>
            See it in action
          </h2>
          <p className="text-fd-muted-foreground mx-auto mt-4 max-w-2xl text-lg leading-relaxed">
            A full-stack Kanban board with bidirectional sync. Go offline, make changes, come back — everything syncs
            across devices.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link
              href="https://kanban.prisma-idb.dev/"
              className="text-fd-primary-foreground inline-flex items-center gap-2 rounded-md bg-[hsl(32,100%,50%)] px-6 py-2.5 text-sm font-medium tracking-wide shadow-md shadow-[hsl(32,100%,50%)]/30 transition-all hover:bg-[hsl(32,100%,45%)] hover:shadow-lg hover:shadow-[hsl(32,100%,50%)]/30"
            >
              <Rocket className="h-3.5 w-3.5" />
              Try the Live Demo
            </Link>
            <Link
              href="https://github.com/prisma-idb/prisma-idb/tree/main/apps/kanban-example"
              className="text-fd-foreground border-fd-border bg-fd-card hover:bg-fd-accent/10 inline-flex items-center gap-2 rounded-md border px-6 py-2.5 text-sm font-medium tracking-wide shadow-sm transition-colors"
            >
              <GitBranch className="h-3.5 w-3.5" />
              View Source
            </Link>
          </div>
        </div>

        <div className="mt-12">
          <DemoPlayer />
          <p className="text-fd-muted-foreground mt-5 text-center text-sm">
            The demo uses manual sync controls.{" "}
            <span className="text-fd-foreground font-medium">
              In production, call <code className="text-fd-accent text-[13px]">worker.start()</code> for fully automatic
              background sync.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
