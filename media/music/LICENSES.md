# 小单音乐库 · 许可证记录

核验日期：2026-09-17。每个文件都在 Wikimedia Commons 上查了两处：

1. **Commons API**（`action=query&prop=imageinfo&iiprop=url|extmetadata|size|mime`）：读取 `LicenseShortName`、`License`、`UsageTerms`、`Artist`、`Credit`。
2. **文件描述页的 wikitext**（`prop=revisions&rvprop=content`）：读取真正挂在页面上的许可模板。

API 的 `LicenseShortName` 只反映页面上第一个机器可读的许可。遇到“作品一个许可、录音另一个许可”的页面（用 `{{Copyright information}}` 或分段写法的），它往往只给出作品的 PD 标记。所以**录音许可以 wikitext 为准**，下文逐条注明两者不一致的地方。

下载的原始文件都用 API 返回的 SHA-1 校验过。

所有乐曲本身都属于公有领域：作曲家去世最晚的是 Satie（1925 年），按作者终身加 70 年计算均已过期，作品也都发表于 1929 年前。

通用处理（由 ffmpeg 7.1.1 完成）：两遍 `loudnorm=I=-18:TP=-2`（实际都回退到 dynamic 模式）→ 混为单声道 → 16 kHz → libopus 32 kbps，`-application audio`，并清除原有元数据。

---

## 1. 摇篮曲：`brahms-lullaby.ogg`

- **作品**：Johannes Brahms, *Wiegenlied* Op. 49 No. 4（Brahms 1897 年去世，公有领域）
- **录音**：Pracchia-78 用虚拟钢琴合成（Colossus Classical Piano SoundFont，据上传说明）
- **来源**：https://commons.wikimedia.org/wiki/File:Johannes_Brahms_ninna_nanna_op_49_n_4.ogg
- **Wikitext 许可模板**：`{{PD-self}}`
- **API extmetadata**：LicenseShortName=`Public domain`；License=`pd`；UsageTerms=`Public domain`；Artist=`Pracchia-78`；Credit=`Own work`
- **额外核对**：上传记录显示上传者就是作者 Pracchia-78（2012-05-29，最初传到 it.wikipedia，2023 年用 FileImporter 迁到 Commons）
- **catalog 许可**：Public Domain
- **处理**：仅做通用处理，时长 109 s

## 2. 小星星：`mozart-twinkle-variations.ogg`

- **作品**：W. A. Mozart, *12 Variations on "Ah vous dirai-je, Maman"* K. 265/300e（公有领域）
- **录音**：Stefano Ligoratti（钢琴），2010 年
- **来源**：https://commons.wikimedia.org/wiki/File:Mozart_-_12_Variations_K._265_-_Stefano_Ligoratti.mp3
- **Wikitext 许可模板**：`{{cc-by-3.0}}`
- **API extmetadata**：LicenseShortName=`CC BY 3.0`；License=`cc-by-3.0`；UsageTerms=`Creative Commons Attribution 3.0`；Artist=`Wolfgang Amadeus Mozart`；Credit=`https://imslp.org/wiki/12_Variations_on_%22Ah,_vous_dirai-je_maman%22,_K.265/300e_(Mozart,_Wolfgang_Amadeus)`
- **额外核对**：IMSLP 作品页上，录音 #72959（Steligo 于 2010/7/29 上传）标注为 "Performer Pages Stefano Ligoratti (piano) … Copyright Creative Commons Attribution 3.0"
- **catalog 许可**：CC BY 3.0
- **署名（必须保留）**："12 Variations on 'Ah vous dirai-je, Maman', K. 265" (W. A. Mozart), performed by Stefano Ligoratti, licensed under CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). Source: IMSLP #72959 via Wikimedia Commons.
- **修改说明**：原曲 12:28，截取开头 0–340 s（主题加前几段变奏，切点落在两段变奏之间的停顿处，约 339 s），并加 2 s 淡出（`afade=t=out:st=338:d=2`）。再做通用处理，时长 340 s

## 3. 梦幻曲：`schumann-traumerei.ogg`

- **作品**：Robert Schumann, *Kinderszenen* Op. 15 No. 7 "Träumerei"（公有领域）
- **录音**：Musopen（Commons 页面未写明钢琴家）
- **来源**：https://commons.wikimedia.org/wiki/File:Robert_Schumann_-_scenes_from_childhood,_op._15_-_vii._dreaming.ogg
- **Wikitext 许可模板**：`'''Music''': {{PD-old-100}}  '''Recording''': {{PD-author|[http://musopen.com Musopen]}}`，另有 `{{PermissionTicket|id=2008012110017088}}`（VRTS 授权已确认）。Permission 字段引用了 Musopen FAQ："The music on this site is given a public domain license…"
- **API extmetadata**：LicenseShortName=`Public domain`；License=`pd`；UsageTerms=`Public domain`；Artist=`Robert Schumann (1810-1856) (see Musopen for performance author information)`；Credit=`http://www.musopen.com`
- **catalog 许可**：Public Domain
- **署名**：无强制要求。Musopen 出于礼貌希望注明 "Musopen (musopen.org)"，并请求不要直接售卖其录音
- **处理**：仅做通用处理，时长 203 s

## 4. 孩子入睡了：`schumann-child-falling-asleep.ogg`

- **作品**：Robert Schumann, *Kinderszenen* Op. 15 No. 12 "Kind im Einschlummern"（公有领域）
- **录音**：Musopen（未写明钢琴家）
- **来源**：https://commons.wikimedia.org/wiki/File:Robert_Schumann_-_scenes_from_childhood,_op._15_-_xii._child_falling_asleep.ogg
- **Wikitext 许可模板**：`'''Music''': {{PD-old-100}}  '''Recording''': {{PD-author|[http://musopen.com Musopen]}}`，另有 `{{PermissionTicket|id=2008012110017088}}`
- **API extmetadata**：LicenseShortName=`Public domain`；License=`pd`；UsageTerms=`Public domain`；Artist=`Robert Schumann (1810-1856) (see Musopen for performance author information)`；Credit=`http://www.musopen.com`
- **catalog 许可**：Public Domain
- **署名**：同第 3 首
- **处理**：仅做通用处理，时长 122 s

## 5. 致爱丽丝：`beethoven-fur-elise.ogg`

- **作品**：Ludwig van Beethoven, Bagatelle in A minor WoO 59 "Für Elise"（公有领域）
- **录音**：V Gao（Wikipedia 用户 Gaodifan），钢琴，2006 年
- **来源**：https://commons.wikimedia.org/wiki/File:FurElise.ogg
- **Wikitext 许可模板**：`{{PD-self}}` 和 `{{cc-zero}}`；Source 字段为 "Self-made -- V Gao (Gaodifan)"；Author 字段写 "Performed by (Gaodifan)"
- **API extmetadata**：LicenseShortName=`Public domain`；License=`pd`；UsageTerms=`Public domain`；Artist=`Ludwig van Beethoven`；Credit=`Self-made -- V Gao (Gaodifan)`
- **额外核对**：上传记录显示上传者是演奏者本人 Gaodifan~commonswiki（2006-07-18）
- **catalog 许可**：Public Domain（页面同时挂有 CC0 1.0）
- **处理**：仅做通用处理，时长 177 s

## 6. 月光：`debussy-clair-de-lune.ogg`

- **作品**：Claude Debussy, *Suite bergamasque*, III. "Clair de lune"（Debussy 1918 年去世，公有领域）
- **录音**：Laurens Goedhart（钢琴），2011-08-20。据原始 SoundCloud 说明，用 Yamaha C3 三角钢琴真实录制
- **来源**：https://commons.wikimedia.org/wiki/File:Clair_de_lune_(Claude_Debussy)_Suite_bergamasque.ogg
- **Wikitext 许可模板**：`{{Copyright information|recording={{cc-by-3.0}}|musical composition={{PD-old-auto-expired|deathyear=1918}}}}`。Permission 字段写的是："Claude Debussy's Clair de Lune by Laurens Goedhart is licensed under a Creative Commons License"，并链接到 https://creativecommons.org/licenses/by/3.0/
- **API extmetadata**：LicenseShortName=`Public domain`；License=`pd`；UsageTerms=`Public domain`；Artist=`Claude Debussy`；Credit=`https://soundcloud.com/laurensgoedhart/claude-debussys-clair-de-lune`
  - **注意**：API 只返回了作品的 PD 标记。录音本身是 **CC BY 3.0**，以 wikitext 为准
- **额外核对**：打开了 Permission 引用的 archive.org 快照（https://web.archive.org/web/20120210054738/http://soundcloud.com/laurensgoedhart/claude-debussys-clair-de-lune）。页面原文为 `"Claude Debussy's Clair de Lune" by Laurens Goedhart is licensed under a [CC BY 3.0 链接]`，徽标 title 为 "This track is released under a CC by license"
- **catalog 许可**：CC BY 3.0
- **署名（必须保留）**："Claude Debussy's Clair de Lune" by Laurens Goedhart, licensed under CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). Source: https://soundcloud.com/laurensgoedhart/claude-debussys-clair-de-lune via Wikimedia Commons.
- **修改说明**：通用处理（响度标准化、单声道、Opus 16 kHz 32 kbps），时长 304 s

## 7. 吉诺佩蒂：`satie-gymnopedie-1.ogg`

- **作品**：Erik Satie, *Gymnopédie* No. 1 "Lent et douloureux"（1888 年发表，Satie 1925 年去世，公有领域）
- **录音**：Robin Alciatore（钢琴），约 2008 年，经 Musopen 发布
- **来源**：https://commons.wikimedia.org/wiki/File:Erik_Satie_-_gymnopedies_-_la_1_ere._lent_et_douloureux.ogg
- **Wikitext 许可模板**：`{{PD-author|Robin Alciatore}}`。Permission 字段写 "Public domain music from musopen.com"，并引用 Musopen FAQ："The music on this site is given a public domain license, therefore, there are technically no restrictions…"
- **API extmetadata**：LicenseShortName=`Public domain`；License=`pd`；UsageTerms=`Public domain`；Artist=`Robin Alciatore`；Credit=`http://www.musopen.com`
- **catalog 许可**：Public Domain
- **处理**：仅做通用处理，时长 184 s

## 8. 糖果仙子之舞：`tchaikovsky-sugar-plum-fairy.ogg`

- **作品**：P. I. Tchaikovsky, *The Nutcracker*, "Dance of the Sugar Plum Fairy"（公有领域）
- **录音/编配**：Kevin MacLeod（incompetech.com），管弦乐加钢片琴编配，2006 年，ISRC USUAN1100270
- **来源**：https://commons.wikimedia.org/wiki/File:Dance_of_the_Sugar_Plum_Fairies_(ISRC_USUAN1100270).oga
- **Wikitext 许可模板**：`{{Cc-by-3.0|attribution=Dance of the Sugar Plum Fairies Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 3.0 License https://creativecommons.org/licenses/by/3.0/}}` 和 `{{attribution}}`
- **API extmetadata**：LicenseShortName=`CC BY 3.0`；License=`cc-by-3.0`；UsageTerms=`Creative Commons Attribution 3.0`；Artist=`Pyotr Ilyich Tchaikovsky / Kevin MacLeod`；Credit=`http://www.incompetech.com/m/c/royalty-free/holiday.html` / `https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100270`；Attribution=`Dance of the Sugar Plum Fairies Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 3.0 License https://creativecommons.org/licenses/by/3.0/`
- **额外核对**：incompetech 页面现行的署名模板是 "… Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License"，同样只要求署名。本库按 Commons 页面记为 CC BY 3.0
- **catalog 许可**：CC BY 3.0
- **署名（必须保留）**：Dance of the Sugar Plum Fairies Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 3.0 License https://creativecommons.org/licenses/by/3.0/
- **修改说明**：通用处理，时长 106 s

## 9. 晨景：`grieg-morning-mood.ogg`

- **作品**：Edvard Grieg, *Peer Gynt* Suite No. 1 Op. 46, I. "Morning Mood"（Grieg 1907 年去世，公有领域）
- **录音**：Musopen Symphony（据 Commons 同曲 ogg 版的说明，由捷克国家交响乐团以 Musopen Symphony 名义演奏），属 Musopen Kickstarter 项目，2012 年
- **来源**：https://commons.wikimedia.org/wiki/File:Grieg_-_Peer_Gynt_Suite_No._1,_Op._46_-_I._Morning_Mood_(Musopen_Symphony).flac（下载的是 FLAC 原件）
- **Wikitext 许可模板**：`{{Copyright information |recording={{PD-author|[https://musopen.org/ Musopen]}} |musical composition={{PD-old-auto-expired|deathyear=1907}} }}`；source 为 `{{Musopen|https://musopen.org/music/777-peer-gynt-suite-no-1-op-46/}}`
- **API extmetadata**：LicenseShortName=`Public domain`；License=`pd`；UsageTerms=`Public domain`；Artist=`Edvard Grieg`；Credit 开头为 `This work comes from the non profit U.S. organization Musopen where it is available at the following link: https://musopen.org/music/777-peer-gynt-suite-no-1-op-46/ The Musopen website requires all uploaders to "represent and warrant that content uploaded to the site is in the public domain"…`
- **额外核对**：同一录音的 `File:Musopen - Morning.ogg` 页面也是 `{{PD-author|[https://musopen.org/music/777-peer-gynt-suite-no-1-op-46/ Musopen]}}`
- **catalog 许可**：Public Domain
- **处理**：仅做通用处理（原件 48 kHz FLAC），时长 229 s

## 10. 哥德堡变奏曲咏叹调：`bach-goldberg-aria.ogg`

- **作品**：J. S. Bach, *Goldberg Variations* BWV 988, Aria（公有领域）
- **录音**：Kimiko Ishizaka（钢琴），Open Goldberg Variations 项目，2012 年
- **来源**：https://commons.wikimedia.org/wiki/File:Goldberg_Variations_01_Aria.ogg
- **Wikitext 许可模板**：`===Composition=== {{PD-old-75-1923}}`，`===Performance=== {{cc-zero}}`
- **API extmetadata**：LicenseShortName=`Public domain`；License=`pd`；UsageTerms=`Public domain`；Artist=`Composer: Johann Sebastian Bach; Performer: Kimiko Ishizaka`；Credit=`Open Goldberg Variations`
  - **注意**：API 只返回作品的 PD 标记。演奏本身是 **CC0 1.0**，以 wikitext 为准
- **catalog 许可**：CC0 1.0
- **处理**：仅做通用处理，时长 300 s

---

## 未采用的候选及原因

| 候选文件 | 查到的许可 | 未采用原因 |
|---|---|---|
| File:Guten Abend gut Nacht.ogg | CC BY-SA 4.0 | 相同方式共享（SA）许可，按要求排除 |
| File:Brahms - Schumann-Heink - Wiegenlied (Berceuse) (1915).ogg | `{{PD-old}}` | 模板只针对作品。1915 年人声录音来自 YouTube，录音本身的状态没有单独说明，而且音质差 |
| File:Lullaby wound up clock guten abend gute nacht.ogg | `{{PD-author\|stephan}}`（PDsounds） | 许可没问题，但音乐盒录音只有 46 s，所以用了更完整的第 1 首 |
| File:Mozart Ah vous dirai-je, Maman.ogg、File:KV.265 … JMC, Han.ogg、File:Variation I (ah! vous dirai-je maman).ogg、File:Twinkle Twinkle Little Star.ogg | CC BY-SA 2.5 / 4.0 | SA 许可 |
| File:Twinkle Twinkle Little Star plain.ogg | `{{PD-old}}` | 只标了作品 PD，录音许可不明，而且只有 24 s |
| File:Twinkle Twinkle Little Star on the Netherlands Carillon.ogg | `{{PD-USGov}}` | 演奏的是 John Courter 的编曲，这份编曲的版权状态没有说明，演奏者也未必是联邦雇员 |
| File:Ah je vous dirai maman theme.wav | `{{PD-old-70-1923}}` | 只标了作品 PD，录音许可不明，只有 15 s |
| File:Mozart - 12 Variations K. 265 - Simone Renzi.mp3 | CC BY 3.0 | 许可可用。已选同许可的 Ligoratti 版，文件更小 |
| File:20091104 Alisa Weilerstein and Jason Yoder - Saint Saëns' The Swan.ogg | 页面写 "the performance is {{CC-BY-3.0}} and assumable to be {{PD-release}} the recording is {{PD-USGov}}" | 演奏部分的许可说法自相矛盾（"assumable"），不够确定 |
| File:Judith Bokor plays Le Cygne by Saint-Saëns.flac | `{{PD-US-expired}}{{PD-old-70}}` | 1925-06-05 录音。美国对 1923–1946 年录音保护到发行后 100 年，但页面没给出确切发行年份，无法确定已进入公有领域；`PD-old-70` 用在演奏者身上也不成立（Bokor 1972 年才去世）。另外音质是 78 转唱片 |
| File:JOHN MICHEL CELLO-SAINT SAENS CARNIVAL OF ANIMALS THE SWAN.ogg、File:Saint-Saens - The Carnival of the Animals - 13 Le cygne.ogg | CC BY-SA 3.0 / 2.0 | SA 许可。结果《天鹅》没有找到可用录音 |
| File:Träumerei (Kinderszenen, Op 15 No 7) - Robert Schumann.wav | CC BY-SA 3.0 | SA 许可 |
| File:For Elise (Für Elise) Beethoven JMC Han.ogg、File:Beethoven Für Elise Rondo.ogg、File:Fur Elise.ogg、File:Daniel Bautista - Beethoven - Para Elisa.ogg | CC BY-SA | SA 许可 |
| File:Clair de Lune by Claude Debussy (1905, piano solo).opus | `{{PD/1923\|1918}}` | 只标了作品 PD，YouTube 来源的录音许可不明 |
| File:Satie Gymnopedie No 1 performed by Michael Laucke.flac | `{{self\|cc-by-sa-4.0}}` + PD-because（作品） | 录音是 CC BY-SA 4.0 |
| File:Satie Gymnopèdie n.1 DariaBaiocchi.wav | CC BY-SA 4.0 | SA 许可 |
| File:Gymnopedie No. 1..ogg | `{{cc-zero}}` | 许可可用，已选 Musopen 版 |
| File:Kevin MacLeod - Erik Satie Gymnopedie No 1.ogg、File:Kevin MacLeod - P I Tchaikovsky Dance of the Sugar Plum Fairy.ogg | CC BY 3.0，但挂着 "License review needed" | 许可审核未完成。《糖果仙子之舞》改用已完整标注署名的 ISRC USUAN1100270 页面 |
| File:Tchaikovsky - Dance of the Sugar Plum Fairy - The Nutcracker.ogg | CC BY 3.0 | 来源只写 "Free Classical Music on YouTube"，真正的权利人不明 |
| File:The Nutcracker (Dance of Sugar Plum Fairy), Piano performer JMC, Han.ogg、File:Danse de la Fée Dragée.ogg | CC BY-SA | SA 许可 |
| File:PDP-CH - … Nutcracker Suite … Decca-k1142-ar9057.flac | PD（无机器可读作者） | 1945 年 Decca 录音，页面没有作者信息，也没说明各国的状态，不确定 |
| File:Minuet in G major, Anh. 114 - Notebook for Anna Magdalena Bach.ogg | `{{PDMark-owner}}`（Musopen） | 许可可用，但只有 50 s，为控制曲目数量未收录 |
| File:Chopin-Berceuse.ogg | `{{PD-self}}` | 音频是公开音乐会的录音，页面没说明上传者是不是演奏者 Veronica van der Knaap，PD-self 的主体不明 |
| File:1 Chopin, Berceuse (piano-Christine Hartley).ogg | CC BY 2.5 | 没有细查 wikitext（曲目已够），未收录 |
