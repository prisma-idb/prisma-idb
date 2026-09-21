/**
 * Reused as-is, not re-implemented: our 3 commands read `contract.output`
 * and `migrations.dir`, both of which live in the `orm` config section
 * (`PrismaNextConfig`), not anything IDB-specific. One `prisma.config.ts`
 * section serves both the generic `prisma` CLI and this shell.
 */
export { ormConfigSection } from "@prisma/orm-toolchain/cli";
