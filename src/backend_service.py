from flask import Flask, request, jsonify
from flask_cors import CORS
import random

app = Flask(__name__)
CORS(app)  # 允许跨域请求

# 模拟的GitHub仓库列表
GITHUB_REPOS = [
    "https://github.com/facebook/react",
    "https://github.com/vuejs/vue",
    "https://github.com/angular/angular",
    "https://github.com/sveltejs/svelte",
    "https://github.com/vercel/next.js",
    "https://github.com/microsoft/TypeScript",
    "https://github.com/nodejs/node",
    "https://github.com/expressjs/express",
    "https://github.com/nestjs/nest",
    "https://github.com/django/django"
]

@app.route('/api/get_repo', methods=['POST'])
def get_repo():
    """根据任务返回一个合适的GitHub仓库链接"""
    data = request.json
    task = data.get('task', '')
    
    # 这里可以添加更复杂的逻辑来匹配任务和合适的仓库
    # 现在简单随机返回一个
    repo = random.choice(GITHUB_REPOS)
    description = "2. 文辉对项目的summary等更加详细的项目描述"
    
    return jsonify({"github_url": repo, "description": description})

@app.route('/api/mid_output', methods=['POST'])
def mid_output():
    """根据任务返回一个合适的GitHub仓库链接"""
    data = request.json
    task = data.get('task', '')
    
    # 这里可以添加更复杂的逻辑来匹配任务和合适的仓库
    # 现在简单随机返回一个
    description = "1. 小非的中间结果输出"
    
    return jsonify({"description": description})

if __name__ == '__main__':
    app.run(debug=True, port=5000) 