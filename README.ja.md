# dsh-delete-guard

[English](README.en.md) | [简体中文](README.md) | **日本語**

**復元できないものは、エージェントに消させない。**

削除の結果は 2 つだけです。Windows のごみ箱に入る（エクスプローラーから元に戻せる）
か、拒否されて `file_trash` 呼び出しに置き換わるか。それ以外はありません。
**内容を書き潰すことも、削除と同じことです。**

```
agent:   Remove-Item -Recurse -Force .\src
拒否:    The delete guard blocked this delete. Re-run this as: file_trash with paths = ["…\src"]
その後:  file_trash → ごみ箱へ移動。「元に戻す」が使える
```

```
agent:   $lines=Get-Content $f; $idx=(…Select-String…).LineNumber; Set-Content $f $lines[0..($idx-2)]
拒否:    …`$idx` is offset by arithmetic in a slice endpoint, it is never checked for $null…
         Fix, then re-run:  if (-not $idx) { throw "anchor not found" }
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

**削除動詞を伴わない破壊**にも規則があります。ファイルを読み、切り出し、同じファイルへ
書き戻す形です。PowerShell では `$lines[0..($null-2)]` はエラーではなく `$lines[0..-2]`、
つまり「先頭行 + 末尾 2 行」になります——605 行が 24 行として静かに保存され得ます。
こうしたコマンドはごみ箱へ送れず（ネットワーク共有にごみ箱はありません）、事後の
サイズ比較でも見つからないため、ガードは書き込みの前に「同一ファイルの読み書き」と
「未検査のスライス端点」として拒否します。

## インストール

```shell
# npm から導入
dsh plugin --profile web add dsh-delete-guard
# またはリポジトリから直接
dsh plugin --profile web add github:deepestevan/dsh-delete-guard
# またはローカルの tarball から（ソースを変更したとき）
pnpm pack --pack-destination ./temp/pack     # 先に package.json の version を上げる
dsh plugin --profile web add file:./temp/pack/dsh-delete-guard-2.4.2.tgz
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
| **同一ファイルの読み書き** | `(Get-Content $f) \| Set-Content $f`、`$c = Get-Content $f; Set-Content $f $c`、`sed -i f`、`cat f > f`、`::ReadAllText` → `::WriteAllText`——新しい内容は唯一のコピーから作られるため、切り出しやフィルタを誤ると復元元が残りません。`.bak` か検証付き一時ファイルを残す書き方は許可 |
| **書き込み文に折り込まれた読み取り** | `Set-Content $f (Get-Content $f \| Select-Object -First 10)`——1 行で読み・切り詰め・書き戻し |
| **変数経由のシェル呼び出し** | `$shellPath='…bash.exe'; & $shellPath -c "rm -rf …"`——プログラム名がリテラルでなく、本体を判定できない |
| **未検査のスライス端点** | 同一コマンド内でファイルを書き、かつ `$idx ± n` を端点に使う（`$l[0..($idx-2)]`、`-First ($i-1)`）。`$idx` は `$null` 検査済みでない。PowerShell はエラーにせず、`0..($null-2)` は `0..-2`（先頭行 + 末尾 2 行）になる |

**許可される**：読み取り専用の作業、削除語に言及するだけのコマンド
（`Select-String -Pattern "Remove-Item"`、`Get-Content shred.exe`）、ごみ箱から
の**復元**、`Add-Content` / `>>` / `-Append`（追記は置き換えない）、`$null` / `/dev/null`
への書き込み、そして**`.bak` か検証付き一時ファイルを先に作る**全面書き換え
また `node -e` / `python -c` の本体で消去ツール名に
**言及**しただけのテキストはプログラム名として扱いません——`exec` / `execSync` / `spawn` /
`system` / `subprocess.*` に渡されたときだけです（`bash -c` の本体はシェルテキストなので
全体で判定します）。

## 2 つのツール

| ツール | 役割 |
| --- | --- |
| `file_trash { paths, reason? }` | 唯一許可された削除手段。ローカルの項目はごみ箱へ移動し、共有の項目はローカルへ複製 → 検証 → 複製をごみ箱へ → その後に元を削除（「ネットワーク共有」参照）。パスごとに結果を報告 |
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
| `blockTruncatingWrites` | `true` | 同一ファイルの読み書きと、書き込みを伴う未検査スライス端点を拒否 |
| `uncRecoverableMove` | `true` | 共有の削除：ローカル NTFS へ複製 → 検証 → 複製をごみ箱へ → その後に元を削除。`false` で拒否のみ |
| `stagingRoot` | `%LOCALAPPDATA%\dsh-delete-guard\staging` | 共有削除のステージング先（ごみ箱のあるローカルボリューム） |

## 消したファイルを戻す

復元はプラグインの機能ではなく、必要でもありません。ごみ箱は OS のものです。
エクスプローラーの右クリック「元に戻す」で戻せます。スクリプトからは
`X:\$Recycle.Bin\<SID>\$I*` のレコードを読み（オフセット 24 が元パスの文字数、
オフセット 28 から UTF-16LE のパス）、目的のものを探して対になる `$R` を
`Move-Item` で戻します。`$R`/`$I` の名前はランダムなので、そのレコードが唯一の索引です。
payload が無いレコードは飛ばし、ローカライズされた動詞名には依存しないこと。

## ネットワーク共有（ごみ箱が無い）

UNC パスにごみ箱はありません。`SHFileOperationW` はそこで**消去して成功を返す**ため、ブリッジは
先に拒否していました。`file_trash` は人が手でやることを 1 回の呼び出しで、決まった順序で行います：

1. ごみ箱のあるローカル NTFS ボリュームへ複製（`%LOCALAPPDATA%\dsh-delete-guard\staging\<時刻>-<名前>`、`stagingRoot` で変更可）
2. 元と突き合わせて検証：相対パス集合・種別・各ファイルのサイズ
3. ステージングフォルダをごみ箱へ——この時点で複製は復元可能
4. その後にだけ元を削除

**保証の範囲**：復元できるのは**内容**（ローカルのごみ箱）であり、**元のパス**ではありません。
共有にごみ箱が無いため、4 は通常の完全削除です。だから順序そのものが安全条件で、4 より前の失敗は
元に触れず、4 はブリッジが複製の収容を確認した後にだけ実行されます。

復元先は共有ではなくステージングパスになります（ごみ箱の `$I` が記録するのはその場所）。ツールは
そのパスを結果に出力します。

複製前に拒否するもの：共有ルート（`\\host\share`）やホスト名のみの形、**リパースポイント**
（ジャンクション／シンボリックリンク）を含むツリー、ステージング先の**空き容量不足**。

`uncRecoverableMove: false` にすると共有パスはそのまま拒否され、複製も削除も行いません。

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
| **読まずに上書き**（`echo x > 既存.md`、`Invoke-WebRequest -OutFile`、`git checkout -- f`） | 意図的な書き換えであり読み書きではない。新しい内容は古い内容に依存せず、`write`/`edit` も同じことをする。すべての書き込み動詞を削除扱いにすると本プラグインが退けた過剰な規則になる |
| 読み書きの中の**間接的な書き込み**（コンパイラ、`npm run build`、`robocopy` の成果物） | 書き込みは子プロセス内で起き、コマンドテキストに証明できる対象が無い |
| 書き込み後のサイズ比較・ロールバック | 戻すには書き込み前のバイト列が必要で、結局は対象の列挙問題に戻る。`tools/post-execute` は結果をフィードバックに変えるだけで、切り詰めを巻き戻せない。毎回ツリーをスナップショットするのは O(ワークスペース) で、しかも UNC 上の対象は含まれない |
| 共有上のものを `Move-Item` / `robocopy /MOV` で移動 | それは「移動」であり「削除」ではない。内容は移動先に残るが、共有側は完全に unlink され、ごみ箱の記録も残らない。記録を残すのは `file_trash` |

対象のシェルツール名：`pwsh`、`powershell`、`cmd`、`bash`、`sh`、`zsh`、`shell`、
`terminal_send`、`terminal_write`。判定は文の命令語・呼び出しの形・プログラム位置で行い、行内に語が現れたかどうかでは見ません。

## テスト

```shell
node test/run-all.mjs
```

8 層・148 ケース：コマンド分類（50）、上書きガード（30）、規則の穴（12）、共有ステージング（8）、
`file_trash` オペランドガード（15）、ホストのスキーマとフック配線（14）、ホストのスキーマ受理（5）、
実ごみ箱に対するエンドツーエンド（14、実 `\\localhost\C$` パスを含む）。`test/` は tarball に
含まれないので、パック前に緑である必要があります。うち 2 層はホスト自身の検証器を読み込むため、
DSH のインストールが無い環境では失敗ではなく**スキップ**として報告されます。

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | バージョン摘要 |
| [SECURITY.md](SECURITY.md) | 脅威モデル：サンドボックスではなくポリシー層 |
| [docs/incidents/](docs/incidents/) | 各規則の根拠となる実測と逐語コマンド（npm パッケージには含まれません） |
| [LICENSE](LICENSE) | MIT |

事故記録はリポジトリに残します。規則の根拠そのものだからです——どのコマンドが、どんな条件で、
何を壊したかが分からない規則は、推測でしか保守できません。

## ライセンス

MIT — [LICENSE](LICENSE)。
