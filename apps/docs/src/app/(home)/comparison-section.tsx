import PrismaIdbLogo from "@/lib/assets/favicon.png";
import { Section, SectionHeader } from "./section";

type Support = "yes" | "partly" | "no";

/** A support level, plus an optional short note on what "partly" (or "yes") means for that tool. */
type Cell = readonly [Support, string?];

interface Row {
  feature: string;
  cells: readonly [Cell, Cell, Cell, Cell];
}

const tools = [
  { name: "Prisma IDB", logo: PrismaIdbLogo.src, invertInDark: false, ours: true },
  { name: "Dexie.js", logo: "/logos/dexie.svg", invertInDark: true, ours: false },
  { name: "RxDB", logo: "/logos/rxdb.svg", invertInDark: false, ours: false },
  { name: "ElectricSQL", logo: "/logos/electric.svg", invertInDark: true, ours: false },
];

// Checked against each project's documentation in November 2026. Keep the notes short; they are the evidence.
const groups: { name: string; rows: Row[] }[] = [
  {
    name: "Developer experience",
    rows: [
      { feature: "Prisma schema and query API", cells: [["yes"], ["no"], ["no"], ["no"]] },
      {
        feature: "Types from your schema",
        cells: [
          ["yes"],
          ["partly", "declared in code"],
          ["partly", "optional, from JSON Schema"],
          ["partly", "declared in code"],
        ],
      },
      {
        feature: "Relations and nested writes",
        cells: [["yes"], ["no"], ["partly", "refs via populate()"], ["partly", "SQL joins in PGlite"]],
      },
      {
        feature: "Versioned migrations",
        cells: [["yes"], ["yes", "version upgrades"], ["yes", "migration strategies"], ["partly", "server side"]],
      },
    ],
  },
  {
    name: "Sync and offline",
    rows: [
      {
        feature: "Two-way sync",
        cells: [
          ["yes"],
          ["partly", "Dexie Cloud add-on"],
          ["yes", "replication plugins"],
          ["partly", "reads; writes via your API"],
        ],
      },
      {
        feature: "Conflict handling",
        cells: [
          ["yes", "server decides"],
          ["partly", "last write wins, in Dexie Cloud"],
          ["yes", "custom handlers"],
          ["no", "left to your backend"],
        ],
      },
      {
        feature: "Works offline",
        cells: [["yes"], ["yes"], ["yes"], ["partly", "reads; offline writes are yours"]],
      },
      { feature: "Ownership checks from your schema", cells: [["yes"], ["no"], ["no"], ["no"]] },
    ],
  },
  {
    name: "Where others are ahead",
    rows: [
      {
        feature: "Live, reactive queries",
        cells: [
          ["partly", "change events"],
          ["yes", "liveQuery"],
          ["yes", "observables"],
          ["partly", "via PGlite"],
        ],
      },
      {
        feature: "Production track record",
        cells: [["partly", "Prisma 8 client is pre-1.0"], ["yes"], ["yes"], ["yes"]],
      },
    ],
  },
];

/** Tints Prisma IDB's column. Set per cell, because a tinted <col> leaves gaps at the group headings. */
const OUR_COLUMN = "bg-[hsl(32,100%,50%)]/[0.05]";
/** Pins the feature column while the table scrolls sideways; below lg the table is wider than the screen. */
const STICKY_CELL = "bg-fd-background sticky left-0 z-10 lg:static";

const SUPPORT_LABEL: Record<Support, string> = { yes: "Yes", partly: "Partly", no: "No" };

/** Each level has its own shape (filled, half, empty), so the table reads without relying on color. */
function SupportMark({ support, ours }: { support: Support; ours: boolean }) {
  if (support === "no") {
    return (
      <span
        aria-hidden="true"
        className="mt-0.75 block size-2.75 shrink-0 rounded-full border border-zinc-400 dark:border-zinc-600"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`mt-0.75 block size-2.75 shrink-0 rounded-full border border-current ${
        ours ? "text-brand-text" : "text-fd-foreground/75"
      }`}
      style={{
        background: support === "yes" ? "currentColor" : "linear-gradient(90deg, currentColor 50%, transparent 50%)",
      }}
    />
  );
}

function Legend() {
  return (
    <div className="text-fd-muted-foreground flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs">
      {(["yes", "partly", "no"] as const).map((support) => (
        <span key={support} className="inline-flex items-center gap-1.5">
          <SupportMark support={support} ours={false} />
          {SUPPORT_LABEL[support]}
        </span>
      ))}
    </div>
  );
}

export function ComparisonSection() {
  return (
    <Section>
      <SectionHeader eyebrow="Compare" title="How does it compare?">
        Each tool makes different trade-offs. Here is where Prisma IDB is strong, and where others are ahead.
      </SectionHeader>

      <div className="relative -mx-6 overflow-x-auto px-6 lg:mx-0 lg:px-0">
        <table className="w-full min-w-180 border-collapse text-sm">
          <caption className="sr-only">Prisma IDB compared with Dexie.js, RxDB and ElectricSQL</caption>
          {/* The feature column stays put while the tools scroll sideways on narrow screens. */}
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={`${STICKY_CELL} py-4 pr-4 text-left`}>
                <span className="sr-only">Feature</span>
              </th>
              {tools.map((tool) => (
                <th
                  key={tool.name}
                  scope="col"
                  className={`px-3 py-4 text-left font-semibold ${
                    tool.ours ? `${OUR_COLUMN} text-brand-text rounded-t-lg` : "text-fd-foreground"
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- static SVG logos from /public; next/image adds nothing for these */}
                    <img
                      src={tool.logo}
                      alt=""
                      width={18}
                      height={18}
                      className={`size-4.5 object-contain ${tool.invertInDark ? "dark:invert" : ""}`}
                    />
                    {tool.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.name}>
              <tr>
                <th
                  scope="colgroup"
                  className={`${STICKY_CELL} text-fd-muted-foreground pt-7 pb-2 text-left text-xs font-semibold tracking-wider whitespace-nowrap uppercase`}
                >
                  {group.name}
                </th>
                <td className={OUR_COLUMN} />
                <td colSpan={3} />
              </tr>
              {group.rows.map((row) => (
                <tr key={row.feature} className="border-fd-border/70 border-t">
                  <th
                    scope="row"
                    className={`${STICKY_CELL} text-fd-foreground py-3 pr-4 text-left align-top font-medium`}
                  >
                    {row.feature}
                  </th>
                  {row.cells.map(([support, note], index) => (
                    <td
                      key={tools[index].name}
                      className={`px-3 py-3 align-top ${tools[index].ours ? OUR_COLUMN : ""}`}
                    >
                      <span className="flex gap-2">
                        <SupportMark support={support} ours={tools[index].ours} />
                        <span className="text-fd-muted-foreground text-xs leading-snug">
                          <span className="sr-only">{SUPPORT_LABEL[support]}. </span>
                          {note}
                        </span>
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      <div className="mt-8">
        <Legend />
      </div>
    </Section>
  );
}
