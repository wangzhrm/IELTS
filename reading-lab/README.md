# IELTS Reading Lab

雅思阅读题库与在线考试系统：PDF 录入、在线答题、批改与成绩发布。

## 运行

```bash
npm install
npm start
```

浏览器打开 http://localhost:3000

## 页面入口

- `/teacher.html` 老师端：PDF 上传与 AI 识别、题库编辑、学生账号管理、AI 设置
- `/select-test.html` 选择测试：Volume/Test 选择、生成学生链接、成绩时间线
- `/grade.html` 批改与发布：AI 比对、人工逐题核实、雅思分数换算、发布成绩
- `/student.html?volume=1&test=1` 学生答题页（由选测试页生成链接）

## 默认账号

- 管理员密码：`admin123`
- 示例学生：`student1` / `study123`

## 说明

- 预置 Volume 1–21，每册 4 个 Test，共 84 套。
- 数据库文件为 `data/ielts.db`，运行时自动生成，不纳入版本控制。
- AI 功能需在老师端「AI 设置」中填写 OpenAI 兼容的 Base URL、API Key 和模型名称。
