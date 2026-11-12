# research/inbox

Drop **human-reviewed** research JSON files (schema `vl-research-1`, see `docs/research-import-format.md`) here, then:

```bash
npm run research:import -- research/inbox/<file>.json          # dry-run, writes nothing
npm run research:import -- research/inbox/<file>.json --apply  # write to the local DB
```

Files in this folder are not imported automatically. Do not put private customer data, payment records or secrets here.
