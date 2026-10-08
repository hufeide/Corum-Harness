cd /home/administator/workspace/Corum-Harness
pnpm web                       # 构建(若缺失) + 起后端 + 打印可点击 URL 并自动开浏览器
CORUM_WEB_NO_OPEN=1 pnpm web  # 不自动打开浏览器，只打印 URL
CORUM_HOME=/home/administator/workspace/Corum-Harness/data pnpm web   # 指定数据目录
