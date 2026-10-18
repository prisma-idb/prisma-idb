import type { ModelSymbol, PslSpan } from "@prisma/orm-framework/psl-parser";
import type { IdbDefinitionPath } from "./contract-definition";

/** Source locations stay outside the plain-data definition and never affect hashes. */
export class PslDefinitionSourceMap {
  private readonly spans = new Map<string, PslSpan>();

  /** Resolve an exact coordinate, without silently falling back to a broader span. */
  get(path: IdbDefinitionPath): PslSpan | undefined {
    return this.spans.get(JSON.stringify(path));
  }

  /** Encode segments separately so names containing punctuation cannot collide. */
  set(path: IdbDefinitionPath, span: PslSpan): void {
    this.spans.set(JSON.stringify(path), span);
  }

  /** Retain field spans even when projection or failed resolution drops a field. */
  recordModel(model: ModelSymbol): void {
    const path = ["models", model.name];
    this.set(path, model.span);
    model.attributes.forEach((attribute, index) => this.set([...path, "attributes", index], attribute.span));
    for (const field of Object.values(model.fields)) {
      const fieldPath = [...path, "fields", field.name];
      this.set(fieldPath, field.span);
      for (const attribute of field.attributes) {
        // Interpretation reads the first attribute of a given name.
        const attributePath = [...fieldPath, "attributes", attribute.name];
        if (this.get(attributePath) === undefined) this.set(attributePath, attribute.span);
      }
      if (field.typeConstructor !== undefined) {
        this.set([...fieldPath, "typeConstructor"], field.typeConstructor.span);
      }
    }
  }
}
