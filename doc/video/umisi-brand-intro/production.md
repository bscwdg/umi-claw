# 制作手册｜素材生成、录屏与合成

成片：1920x1080 / 30fps / MP4 / 约 60 秒，响度 -14 LUFS。

## 一、统一设定（AI 镜头连续性的关键）

人物与场景在每条提示词中保持完全一致：

- 场景：深夜居家工作台，深灰墙面；一张原木色书桌；一台 27 寸显示器发冷蓝光；左侧一盏暖黄台灯；桌上有合上的笔记本、一杯水；背景是虚焦的城市夜灯光点。
- 人物：25 岁左右亚洲女性创作者，齐肩黑色长发，不戴眼镜，深灰色圆领卫衣。全片只给侧影、背影、手部和下颌以下，不给正脸，规避跨镜头脸部不一致。
- 影像：35mm 电影镜头质感，浅景深，冷暖对比（屏幕冷蓝 vs 台灯暖橙），轻微胶片颗粒，低饱和，真实光影，不广告感。
- 通用负面要求：无字幕、无 logo、屏幕上不出现可读文字、无夸张表情、无卡通感、无赛博朋克霓虹、无慢动作炫技。

生成参数建议：即梦/可灵/Seedance 任选主力，5 秒/条，1080p，16:9；每条至少生成 3 版选 1；选定人物形象后固定首帧或种子再生成其余镜头。A1 与 A2 是同一场运动的前后半段，务必用同一首帧连续生成。

## 二、AI 镜头提示词

### A1（00-05）屏幕亮起

中文：
全黑的深夜房间，一块电脑显示器从黑暗中缓缓亮起，冷蓝色屏幕光勾勒出坐在桌前的人的侧脸轮廓和放在键盘上的手，镜头缓慢向屏幕推近，屏幕内容是抽象的流动光晕、没有任何可读文字，细微尘粒在光束中缓慢漂浮。电影感，35mm，浅景深，胶片颗粒，克制真实。

English:
A pitch-dark room at night. A computer monitor slowly brightens, cold blue light tracing the profile silhouette of a person at a desk and their hands resting on the keyboard. The camera slowly pushes toward the screen, which shows only abstract flowing light with no readable text. Tiny dust particles drift in the light beam. Cinematic, 35mm, shallow depth of field, subtle film grain, restrained and realistic, 16:9.

### A2（05-10）拉远，思考

中文：
同一张深夜书桌，镜头从电脑屏幕继续向后缓缓拉远，露出人物坐着的侧后方背影，她停止打字，身体轻轻后靠，望向屏幕若有所思；一盏暖黄色台灯在侧面亮着，与屏幕的冷蓝光形成冷暖对比，房间安静、空旷。镜头运动平稳缓慢，电影感，浅景深。

English:
Same desk at night. The camera pulls back from the monitor to reveal the person from behind and slightly side-on. They stop typing, lean back gently, gazing at the screen in thought. A warm yellow desk lamp glows at the side against the cold blue monitor light. Quiet, empty room, slow smooth dolly, cinematic, shallow depth of field, film grain, 16:9.

### A3（10-15）机械地聊天

中文：
侧面中景，同一个人在深夜面无表情地、机械地敲击键盘与电脑对话，眼睛盯着屏幕，神情疲惫而重复，冷蓝色屏幕光打在脸上，镜头极缓慢地横向移动，氛围单调、安静。电影感，真实，浅景深，无可读屏幕文字。

English:
Medium side shot of the same person typing mechanically at night with a blank, tired expression, repeatedly chatting with the computer, cold blue light on their face. The camera drifts sideways extremely slowly. Monotonous, quiet mood. Cinematic realism, shallow depth of field, no readable text on screen, 16:9.

### A4（43-45）手部点击

中文：
书桌特写，只出现一只手按下鼠标左键完成一次确认点击，屏幕光在指节和桌面上微微跳动，暖色台灯光从侧面照来，浅景深，指尖动作干净、有按下即完成的笃定感。电影感微距，真实材质。

English:
Close-up of a hand pressing a mouse button in a single decisive click at a desk. Screen light shimmers on the knuckles and tabletop, warm lamp light from the side, shallow depth of field, realistic skin texture, cinematic macro, 16:9.

### A5（49-55）暖光收束

中文：
同一张书桌，但光线变成清晨或傍晚般的柔和暖色调，人物平静地合上笔记本电脑，轻轻靠向椅背，肩膀放松下来，脸上有释然的安静表情（依然以侧逆光为主，不给正脸）。镜头缓慢向后拉并轻微上升，尘埃在暖光中漂浮。氛围温暖、平静、克制。电影感，浅景深。

English:
The same desk bathed in soft warm light like early morning or late evening. The person calmly closes the laptop and leans back into the chair, shoulders relaxing with a quiet, relieved expression, mostly in side-backlight, no frontal face. The camera pulls back and rises slightly, dust floating in the warm light. Tender, peaceful, restrained. Cinematic, shallow depth of field, 16:9.

## 三、真实录屏脚本（R1-R5）

录前准备：

- 用专用演示数据：待办、工作记录、日报内容提前编好，干净、真实、不涉密；关闭所有系统通知与 IM 弹窗。
- 1920x1080 录制，窗口最大化，隐藏书签栏/任务栏或使用干净浏览器配置；统一浅色界面（与暖色镜头相容），如应用有深色模式则全片录屏统一用一种。
- 鼠标移动放慢到平时的 0.7 倍，每个操作后停 0.5 秒；宁可素材长，剪辑里再加速。
- 界面文案以 Umi Claw 实际版本为准；若功能名称与本表不同，按实际名称录。

### R1（15-22，7 秒，三段各约 2.3 秒）

1. 浏览器中 3-4 个资料标签页被快速归拢：拖入同一文件夹，或用 AI 侧边栏对页面生成一段总结。
2. 代码编辑器中触发一次完整的函数级自动补全，逐行接受生成结果。
3. Umi Claw 中勾选一条今日待办为完成，再把一条 AI 候选工作记录点「确认」。

### R2（24-30，6 秒）

1. 学习笔记文档从上往下缓慢滚动：AI 概念图解 + 简明的中文批注（3 秒）。
2. 工具实测对比表滚动：列含「工具 / 适用场景 / 实测结论」，结论列具体、简短（3 秒）。

### R3（30-37，7 秒）

Umi Claw AI 工具箱发起一次任务（会议纪要或摘要）：发起 → 流式输出过程（日志/文字滚动 3-4 秒）→ 结构化结果卡片出现并停稳。一镜到底，不切镜头。

### R4（37-43，6 秒）

打开进入「新的一天」：今日待办聚合列表出现，能看到例事与「AI 提取」标签；对一条 AI 提取的待办点「确认」；鼠标移开，列表停稳 1 秒。

### R5（45-49，4 秒）

会议纪要结果中「待办」区块短暂高亮 → 切到「日报」：AI 聚合事实并生成日报成稿 → 点「复制」，出现已复制反馈。每个动作约 1.2 秒，剪辑点踩在界面切换上。

## 四、品牌卡（L1 / L2，代码生成）

技术路线：单文件 HTML + Canvas 2D，暴露 window.render(t)，Playwright 逐帧渲染，与知识视频流水线一致。

- L1（22-24）：近黑底 #07070d，一根 1px 冷白线从左到右画出 UmiSI 文字标，2 秒内完成，末端轻微定格；不加标语。
- L2（55-60）：同样底色，标识缓入居中（0.8 秒），标语「让 AI 真正帮你做事」在标识下方逐字显形（约 2 秒），之后完全静止 1.5 秒；全程仅有极慢的微光呼吸。
- 标识右上角小水印从 L1 开始固定到片尾（x≈92%, y≈6%），建立系列感。

待提供：UmiSI logo 矢量文件（SVG/AI）、品牌字体、品牌色值。在 logo 到手前可用文字标先出样片。

## 五、声音

- 旁白：优先真人录音；每句一录，句前句后各留 1 秒环境声；采样 48kHz。
- BGM：70-80 BPM 氛围配乐，钢琴/合成器铺底即可；有旁白时压低到 -22dB 以下，R3-R5 工作闭环段轻微抬起，A5 转暖时收简为单乐器。
- 音效（少而准）：00s 屏幕亮起的微弱电流声、22s 标识画出的柔和 whoosh、44s 鼠标确认的轻微 click、55s 一个温暖低频收束。
- 总响度 -14 LUFS，预留平台压缩余量。

## 六、合成与自检

推荐剪辑：剪映专业版（字幕、响度、9:16 二剪最省事）。

1. 按 storyboard.md 时间轴铺旁白 → BGM → 12 条画面素材，转场照表执行。
2. 烧录字幕，检查手机端字号（物理距离看一遍手机）。
3. 全屏通看三遍：前 3 秒是否想划走、录屏段是否看懂在做什么、结尾标语是否被记住。
4. 重点排查：AI 镜头里的畸形手部/乱码文字（直接弃用重生）、录屏里的真实人名与敏感信息、字幕与旁白不同步、品牌卡与录屏色温不一致（统一往暖调收）。
5. 导出 1080p 横版母版，再按 storyboard 末尾的规范剪 9:16 竖版。

## 七、待你提供 / 拍板

- UmiSI logo 源文件与品牌字体、色值。
- 旁白由谁录（你本人 / TTS 样音）。
- 主力 AI 视频工具（即梦、可灵、Seedance、Sora 任一，提示词已中英双备）。
- 演示数据可否由我在 Umi Claw 里按脚本编一批（待办/记录/日报文案我来起草，你过目）。
