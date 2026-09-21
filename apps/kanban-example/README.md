# Prisma IDB - Kanban Example

A fully functional **offline-first kanban board** that demonstrates the power of the [Prisma IDB generator](https://github.com/prisma-idb/prisma-idb). Create, organize, and sync your tasks seamlessly.

**[🚀 Live Demo](https://kanban.prisma-idb.dev/) • [📖 Full Documentation](https://prisma-idb.dev/) • [📦 npm Package](https://www.npmjs.com/package/@prisma-idb/idb-client-generator) • [🏗️ Main Repository](https://github.com/prisma-idb/prisma-idb)**

## Features

### 🗂️ Full Kanban Functionality

- Create and manage multiple boards
- Organize todos into kanban columns (To Do, In Progress, Done)
- Drag-and-drop reordering (visual demo)
- Real-time board and todo management

### 📱 Offline-First Architecture

- **IndexedDB Storage**: All data persists locally in the browser
- **Works Offline**: Create and edit todos without internet connection
- **Automatic Sync**: Changes sync when back online

### 🔄 Background Sync Worker

- Dedicated Web Worker for syncing data with backend
- **Manual Sync**: Click to push/pull changes immediately
- **Auto Sync**: Enable continuous background synchronization
- **Status Monitoring**: Visual indicators for sync status (idle, pushing, pulling)

### 🤝 Multi-User Collaboration

- Multiple users can work on the same board
- Real-time updates when changes are synced
- Built-in conflict resolution via outbox pattern

### 🏗️ Type-Safe Development

- **Generated Client**: Entire IndexedDB client auto-generated from Prisma schema
- **Full TypeScript**: No manual type definitions needed
- **Type-Aware Queries**: All queries are fully type-checked

## Architecture

### Tech Stack

- **Frontend**: SvelteKit with Tailwind CSS
- **Database (Client)**: IndexedDB + Prisma IDB Generator
- **Sync Pattern**: Outbox Pattern + Web Workers
- **UI Components**: shadcn-svelte

### Data Models

The app uses a simple three-model structure with User ownership:

```prisma
model User {
  id            String    @id
  name          String
  email         String    @unique
  emailVerified Boolean   @default(false)
  image         String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  boards        Board[]
  // ... auth fields (excluded from sync)
}

model Board {
  id        String   @id @default(uuid())
  name      String
  createdAt DateTime @default(now())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  todos     Todo[]
}

model Todo {
  id          String   @id @default(uuid())
  title       String
  description String?
  isCompleted Boolean  @default(false)
  createdAt   DateTime @default(now())
  boardId     String
  board       Board    @relation(fields: [boardId], references: [id], onDelete: Cascade)
}
```

### Sync Flow

1. **Client-Side**: Changes stored in IndexedDB, then added to outbox table
2. **Sync Worker**: Background worker detects outbox changes
3. **Push Phase**: Sends changes to backend via API
4. **Pull Phase**: Fetches updated data from server
5. **Local Update**: Updates local IndexedDB with server changes

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm

### Installation

```bash
cd apps/kanban-example
pnpm install
```

### Development

```bash
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Building

```bash
pnpm build
pnpm preview
```

## Testing

Run Playwright tests to verify the sync and UI functionality:

```bash
pnpm test
```

## Project Structure

```
src/
├── routes/
│   ├── +page.svelte          # Landing page
│   ├── login/                 # Authentication
│   └── (app)/
│       ├── dashboard/         # Main kanban board
│       ├── settings/          # App settings
│       └── components/
│           ├── nav-sync.svelte    # Sync status & controls
│           ├── app-sidebar.svelte  # Navigation
│           └── ...
├── lib/
│   ├── prisma-idb/            # Generated IDB client
│   ├── components/            # shadcn-svelte components
│   └── server/                # Server utilities
└── prisma/
    └── schema.prisma          # Prisma schema
```

## Key Components

### `nav-sync.svelte`

Controls the sync worker:

- View current sync status
- Manually trigger push/pull
- Toggle auto-sync mode
- Monitor sync statistics

### `todos-state.svelte`

Manages application state:

- Stores sync worker instance
- Provides reactive state for boards and todos
- Handles user authentication context

## Learning Resources

- [Prisma IDB Generator](https://prisma-idb.dev/) - Complete documentation and guides
- [Main Repository](https://github.com/prisma-idb/prisma-idb) - Source code and issue tracking
- [npm Package](https://www.npmjs.com/package/@prisma-idb/idb-client-generator) - Install the generator
- [IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
- [Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html)

## Contributing

This is an example application. To contribute improvements or report issues, visit the [main repository](https://github.com/prisma-idb/prisma-idb).

## License

MIT
