[中文](#cn-v0.2.1) | [English](#en-v0.2.1)

<h3 id="cn-v0.2.1">体验优化</h3>

- 峰谷规则卡片与条目卡片同构：默认收敛成「名字 + 一行摘要（时区 · 高峰星期 · 高峰时段）+ 编辑键」，点「编辑」展开，展开后带「完成」键。
- 自定义规则可以就地改名，改名会同步所有引用它的条目；重名或空名就地标红并退回原名。
- 条目表单的「峰谷规则」下拉框不再要求先勾「区分峰谷」——选中一个规则本身就等于开启峰谷，空闲价以高峰价为初值。
- 规则摘要里的高峰星期改用全称并写成区间（`周一 至 周五`），不再是星期按钮上的单字。
- 高峰时段改为时、分两个窄输入框：超范围的两位输入（`25` 时、`61` 分）只保留后一位，非法时刻敲不进去；未补零的中间态（`9:5`）在保存时补齐为 `09:05`；结束不晚于开始的行就地标红并在保存前拦下。

### 问题修复

- 在面板里新增或编辑峰谷规则后点「保存」，规则不再消失：此前保存时会把没有被任何条目引用的规则丢掉，手工写进文件的规则也会被一次无关的保存抹掉。
- 覆盖内置的 `deepseek` 规则现在会作用到内置价目条目：此前内置条目内联了一份规则副本，改动不会传播过去。
- 删掉仍被条目引用的规则时，条目的引用被清空但已填好的空闲价保留，保存前提示重新选择，而不是让 host 直接拒绝。
- 设置页根节点的 `.tf_settings` 样式此前从未生效。

<h3 id="en-v0.2.1">Improvements</h3>

- Rule cards now mirror entry cards: collapsed by default into "name + one-line summary (timezone · peak weekdays · peak windows) + Edit", expanding on Edit and collapsing on Done.
- A custom rule's name is edited in place, and renaming updates every entry that references it; an empty or duplicate name is flagged in place and reverts.
- The entry form's "Tariff schedule" dropdown no longer requires ticking "Separate peak/off-peak" first — picking a rule turns peak/off-peak on, with the off-peak prices starting as a copy of the peak ones.
- The summary spells peak weekdays in full and writes ranges as `Monday to Friday`, instead of the single characters used on the weekday buttons.
- Peak windows are entered as two narrow fields per clock: a two-digit value out of range (`25` hours, `61` minutes) keeps only the last digit, so an impossible time cannot be typed; an unpadded intermediate (`9:5`) is padded to `09:05` on save; a row that does not end after it starts is flagged in place and blocked before saving.

### Bug fixes

- Adding or editing a peak/off-peak rule in the panel and then hitting Save no longer loses the rule: saving used to drop every rule that no entry referenced yet, and a hand-written rule could be wiped by an unrelated save.
- Overriding the built-in `deepseek` rule now reaches the built-in pricing entries; they used to carry an inlined copy of the rule, so the edit never propagated.
- Deleting a rule that entries still reference clears those references but keeps the off-peak prices already filled in, and reports before saving that a rule must be picked again, instead of letting the host reject the write.
- The settings page root's `.tf_settings` styling had never been applied.
