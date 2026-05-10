# NestJS Example

GraphVault can be registered once and injected as a normal Nest provider.

```ts
import { Injectable, Module } from "@nestjs/common";
import { GraphVaultModule, StorageManager } from "@sprengmeister/graphvault";

class AppRoot {
  documents: Array<{ id: string; title: string }> = [];
}

@Injectable()
export class DocumentsService {
  constructor(private readonly storage: StorageManager<AppRoot>) {}

  async create(title: string): Promise<void> {
    await this.storage.update((root) => {
      root.documents.push({
        id: crypto.randomUUID(),
        title,
      });
    });
  }

  list(): Array<{ id: string; title: string }> {
    return this.storage.root.documents;
  }
}

@Module({
  imports: [
    GraphVaultModule.forRoot<AppRoot>({
      global: true,
      storageDirectory: "./data/graphvault",
      rootFactory: () => new AppRoot(),
      writeProfile: "fast",
    }),
  ],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class AppModule {}
```

Use `writeProfile: "standard"` when inspectable local files and strict fsync behavior matter most. Use `writeProfile: "fast"` or `"maximum"` for write-heavy services after measuring your own graph.
