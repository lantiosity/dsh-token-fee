[中文](#cn-v0.2.3) | [English](#en-v0.2.3)

<h3 id="cn-v0.2.3">问题修复</h3>

- 修复「高峰用量比规则算出来的多出一成以上」：一个样本属于哪个时段，此前是在折叠时定下并写进持久化投影状态的，标签一旦落盘就冻结，事后补规则或补价格都改不动历史。现在有效价目表的内容指纹并进了投影的 `stateVersion`——**改价格、改规则、增删条目都会让检查点失效，整段日志按新表重折一遍**，历史跟着新规则走。
- 修复兜底值冒充高峰：匹配不到价目条目、或条目只填了统一单价时，样本此前被记为高峰，而那两档价格在文件里根本不存在。现在这类样本标为「不分峰谷」，明细面板会单独列出「未记录时段」的用量（按统一单价计入），不再默默算成高峰。
- 时间戳不可用的样本同样不再被当成高峰。

<h3 id="en-v0.2.3">Bug fixes</h3>

- Fixed "peak usage exceeds what the rule computes by more than a tenth": which period a sample belongs to was decided at fold time and written into the persisted projection state, and once written that label was frozen — adding a rule or a price afterwards could not change history. A content fingerprint of the effective pricing table now feeds the projection's `stateVersion`, so **editing a price, a schedule, or the entry list invalidates the checkpoint and the whole log is refolded under the new table**, and history follows the current rule.
- Fixed the fallback passing itself off as peak: a sample whose model matched no pricing entry, or matched an entry with a single unit price only, used to be labelled peak even though no two-tier price existed in the file. Such samples are now labelled "no peak/off-peak split", and the breakdown panel lists their usage separately as "without a period" (counted at the single unit price) instead of quietly counting it as peak.
- A sample with an unusable timestamp is no longer treated as peak either.
