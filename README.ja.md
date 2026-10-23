# dsh-delete-guard

[English](README.en.md) | [简体中文](README.md) | **日本語**

**復元できないものは、エージェントに消させない。**

削除の結果は 2 つだけです。Windows のごみ箱に入る（エクスプローラーから元に戻せる）
か、拒否されて `file_trash` 呼び出しに置き換わるか。それ以外はありません。

```
agent:   Remove-Item -Recurse -Force .\src
拒否:    The delete guard blocked this delete. Re-run this as: file_trash with paths = ["…\src"]
その後:  file_trash → ごみ箱へ移動。「元に戻す」が使える
```

## 何を解決するか

DSH では、モデルが `pwsh` で削除を実行するとファイルはそのまま消えます。`ctx.fs` に
delete は無く、`ctx.shell` にあるのは `execute()` だけで、その間に何も挟まりません。
`Remove-Item -Recurse -Force` の一言でディレクトリごと消え、ごみ箱も取り消しもありません。

本プラグインは `tools/pre-execute`（ホストがすべてのツール呼び出しを通す接点）にフックし、
そうした呼び出しを**拒否**して、`file_trash` を使うようモデルに伝えます。`file_trash` は
`SHFileOperationW(FOF_ALLOWUNDO)` で移動します——エクスプローラーと同じ Win32 API なので、
`$Recycle.Bin` の `$I`/`$R` メタデータが正しく作られ、「元に戻す」が機能します。

対象は `Remove-Item` だけではありません。パイプ、`xargs`、変数で組み立てた対象、
`if { }` 内の削除、インラインの `-Command` / `-EncodedCommand`、永続ターミナル、
Git Bash の `/c/...` パス、ごみ箱を空にするあらゆる書き方に規則があります。

## インストール

```shell
# npm から導入
dsh plugin --profile web add dsh-delete-guard
# またはリポジトリから直接
dsh plugin --profile web add github:deepestevan/dsh-delete-guard
# またはローカルの tarball から（ソースを変更したとき）
pnpm pack --pack-destination ./temp/pack     # 先に package.json の version を上げる
dsh plugin --profile web add file:./temp/pack/dsh-delete-guard-2.2.2.tgz
# dsh web を再起動（lib/*.js はプロセス起動時に読み込まれる）
```

更新は `remove` → `add` の 2 段階です。`add` だけだと `Already up to date` を返して何も
変わらないことがあり、`lib/*.js` はプロセス再起動でしか読み直されません。

## 何を止めるか

**ごみ箱へ誘導される**

```
Remove-Item C:\tmp\a.txt        del / erase / rd / rmdir / rm / unlink
Remove-Item -Recurse -Force C:\tmp\dir
if (Test-Path $p) { Remove-Item $p -Force }
terminal_send: "Remove-Item C:\tmp\a.txt"
```

**そのまま拒否する**

| 区分 | 例 |
| --- | --- |
| 対象を証明できない | `Remove-Item $(…)`、`… \| Remove-Item`、`xargs rm`、`Remove-Item @targets`、`-Recurse C:\tmp\*` |
| 危険なパス | `C:\`、`\`、`C:\Windows`、`Program Files`、`..\..\`、Git Bash の `~` と `/tmp` |
| 削除動詞を伴わない消去 | `[System.IO.File]::Delete(…)`、`Invoke-Expression "…"`、`cmd /c del`、`robocopy /MIR`、`find -delete` |
| 完全消去ツール | `shred`、`sdelete`、`srm`、`cipher /w`、`format X:`（プログラム位置のみで判定） |
| ごみ箱の空化 | `Clear-RecycleBin`（素の形・`&`・子シェル・`-EncodedCommand`）、`SHEmptyRecycleBin`、ごみ箱項目のシェル動詞、`$Recycle.Bin` 配下の直接削除 |
| ごみ箱が無い場所 | UNC 共有と exFAT/FAT32 ボリューム（そこで「ごみ箱へ」は完全消去と同じ） |
| スクリプト内の削除 | シェル / Python / Node のインライン本体、および削除語を含むテキストの `.ps1`/`.sh`/`.py` への書き込み |

**許可される**：読み取り専用の作業、削除語に言及するだけのコマンド
（`Select-String -Pattern "Remove-Item"`、`Get-Content shred.exe`）、そしてごみ箱から
の**復元**。

## 2 つのツール

| ツール | 役割 |
| --- | --- |
| `file_trash { paths, reason? }` | 唯一許可された削除手段。ごみ箱へ移動し、パスごとに結果を報告し、完全削除へフォールバックしない |
| `trash_status { drive? }` | そのボリュームのごみ箱の項目数とバイト数。削除が本当に入ったかの確認に使う |

## 設定

プロファイルの `cordis.patch.yml` で上書きします（`config` はブロックごと置き換わるので、
残したいキーはすべて書き直す）：

| キー | 既定値 | 意味 |
| --- | --- | --- |
| `enabled` | `true` | 全体スイッチ |
| `blockDestructiveCommands` | `true` | シェル削除を横取りし `file_trash` へ誘導 |
| `forbidEmptyRecycleBin` | `true` | ごみ箱の空化・改変を拒否 |
| `forbidWipe` | `true` | `shred` / `sdelete` / `srm` / `cipher /w` / `format` を拒否 |
| `blockScriptDeletes` | `true` | スクリプトファイルとインライン文字列内の削除を拒否 |

## 消したファイルを戻す

復元はプラグインの機能ではなく、必要でもありません。ごみ箱は OS のものです。
エクスプローラーの右クリック「元に戻す」で戻せます。スクリプトからは
`X:\$Recycle.Bin\<SID>\$I*` のレコードを読み（オフセット 24 が元パスの文字数、
オフセット 28 から UTF-16LE のパス）、目的のものを探して対になる `$R` を
`Move-Item` で戻します。`$R`/`$I` の名前はランダムなので、そのレコードが唯一の索引です。
payload が無いレコードは飛ばし、ローカライズされた動詞名には依存しないこと。

## 何を守らないか

| 対象外 | 理由 |
| --- | --- |
| スクリプトファイル内に既にある削除 | 本体をガードは見ない。書き込みと、見えるインライン形を拒否するまで |
| `Add-Type` で書いた任意の C#（`DeleteFileW` など） | テキスト判定の外。ごみ箱専用 API だけは名前で塞ぐ |
| コマンド名を変数に組み立てて `& $c` | テキストでは評価できない |
| ツール名リスト外の実行経路（独自名のシェル、第三者プラグイン） | リストは明示的（下記） |
| ターミナル送信 2 回に分けて組み立てた削除 | 1 回の送信のテキストしか見ていない |
| Windows 以外 | ブリッジが `SHFileOperationW` |
| 空き容量の枯渇 | 同一 NTFS ボリューム内のごみ箱移動は rename で、新しい容量を使わない |

対象のシェルツール名：`pwsh`、`powershell`、`cmd`、`bash`、`sh`、`zsh`、`shell`、
`terminal_send`、`terminal_write`。判定は文の命令語・呼び出しの形・プログラム位置で行い、行内に語が現れたかどうかでは見ません。

## テスト

```shell
node test/run-all.mjs
```

5 層・90 ケース：コマンド分類（49）、`file_trash` オペランドガード（15）、ホストの
スキーマとフック配線（11）、ホストのスキーマ受理（5）、実ごみ箱に対するエンドツーエンド
（10）。`test/` は tarball に含まれないので、パック前に緑である必要があります。うち 2 層
はホスト自身の検証器を読み込むため、DSH のインストールが無い環境では失敗ではなく
**スキップ**として報告されます。

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | バージョン摘要 |
| [SECURITY.md](SECURITY.md) | 脅威モデル：サンドボックスではなくポリシー層 |
| [LICENSE](LICENSE) | MIT |

設計の根拠、各回の実測値、リリース手順はメンテナ側のエンジニアリングノートであり、
このリポジトリにもパッケージにも含まれません。

## ライセンス

MIT — [LICENSE](LICENSE)。
