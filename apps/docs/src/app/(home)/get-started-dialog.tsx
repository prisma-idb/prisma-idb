"use client";

import { useId, useRef, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, X } from "lucide-react";

const options = [
  {
    title: "Prisma 8",
    badge: "Recommended",
    description: "The Prisma 8 client for IndexedDB, with versioned migrations and sync. Start here for new projects.",
    href: "/docs/prisma-8/getting-started",
  },
  {
    title: "Prisma 6 or 7",
    description: "The generator for existing Prisma 6 and 7 projects. Still supported.",
    href: "/docs/quick-start",
  },
];

interface GetStartedDialogProps {
  className?: string;
  children: ReactNode;
}

/** A button that asks which Prisma version the reader uses, then links to that version's quick start. */
export function GetStartedDialog({ className, children }: GetStartedDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The page renders this dialog more than once, so its title id must be unique.
  const titleId = useId();

  return (
    <>
      <button type="button" className={className} aria-haspopup="dialog" onClick={() => dialogRef.current?.showModal()}>
        {children}
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        // Close when the backdrop, which is part of the dialog element, is clicked.
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
        className="bg-fd-background text-fd-foreground border-fd-border m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border p-0 text-left shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm"
      >
        <div className="p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold">
                Which Prisma version do you use?
              </h2>
              <p className="text-fd-muted-foreground mt-1 text-sm">The setup and the API differ between versions.</p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => dialogRef.current?.close()}
              className="text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent/10 -mt-1 -mr-1 rounded-md p-1.5 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <ul className="space-y-3">
            {options.map((option, index) => (
              <li key={option.href}>
                <Link
                  href={option.href}
                  // Focus the recommended option when the dialog opens.
                  autoFocus={index === 0}
                  className="group border-fd-border hover:bg-fd-accent/10 flex items-center gap-4 rounded-lg border p-4 text-left transition-colors hover:border-[hsl(32,100%,50%)]/60"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-medium">
                      {option.title}
                      {option.badge && (
                        <span className="rounded-full bg-[hsl(32,100%,50%)]/15 px-2 py-0.5 text-[11px] font-medium text-[hsl(32,100%,40%)] dark:text-[hsl(32,100%,60%)]">
                          {option.badge}
                        </span>
                      )}
                    </p>
                    <p className="text-fd-muted-foreground mt-1 text-sm">{option.description}</p>
                  </div>
                  <ArrowRight className="text-fd-muted-foreground h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </dialog>
    </>
  );
}
