# Native Parquet preview for Zed (upstream prototype)

The extension in this repo can't draw UI, so it can't put Parquet data in a table inside Zed. This directory holds a patch for Zed itself. The patch teaches Zed's built-in table preview (`crates/tabular_data_preview`) to open `.parquet` files directly. It's a prototype for a possible upstream contribution, tracked in [#1](https://github.com/elviskahoro/zed-csv/issues/1).

| File | What it is |
|---|---|
| `ZED_COMMIT` | The zed-industries/zed commit the patches apply to |
| `*.patch` | `git format-patch` output, applied in name order |
| [`../../.rwx/zed-parquet.yml`](../../.rwx/zed-parquet.yml) | RWX pipeline that builds and tests the patched Zed |

## Build and test on RWX

You don't need a local Zed build:

```sh
rwx run .rwx/zed-parquet.yml --target test --target lint --wait   # apply patches; tests, rustfmt, clippy
rwx run .rwx/zed-parquet.yml --target report --wait   # also release-build Zed before/after and write report.md
```

`rwx run` uploads uncommitted changes, so you can iterate on a patch without pushing.

The `code` task clones `elviskahoro/zed-csv` by URL, because CLI-triggered runs don't expose the repository. In a fork, change `repository` in that task.

The `*-base` tasks build unpatched Zed at `ZED_COMMIT`. Their inputs never change, so after the first run they come from cache. The patched tasks start from that warm build and only recompile what the patch touches.

## Edit the patch

```sh
git clone https://github.com/zed-industries/zed && cd zed
git checkout -b tabular-data-parquet "$(cat ../zed-csv/upstream/zed/ZED_COMMIT)"
git am ../zed-csv/upstream/zed/*.patch
# ...edit, commit (amend or add commits)...
git format-patch "$(cat ../zed-csv/upstream/zed/ZED_COMMIT)" -o ../zed-csv/upstream/zed/
```

To move to a newer Zed, rebase the branch onto the new commit, update `ZED_COMMIT`, and re-export the patches. The first run after that rebuilds the base from scratch.

## Contributing upstream

Zed's [CONTRIBUTING.md](https://github.com/zed-industries/zed/blob/main/CONTRIBUTING.md) asks for three things before a PR:
- a GitHub Discussion that staff have engaged with;
- a human who understands the change;
- local manual testing with screenshots.

PRs written by autonomous agents are rejected. The discussion and PR text must be written by the person proposing the change. The build report from the `report` target gives the facts to cite: binary-size change, added crates, and test results.
