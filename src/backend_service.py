from flask import Flask, request, jsonify
from flask_cors import CORS
import random
import requests
import os

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
    
    return jsonify({"github_url": repo})

@app.route('/api/mid_output', methods=['POST'])
def mid_output():
    """根据任务返回一个合适的GitHub仓库链接"""
    data = request.json
    task = data.get('task', '')
    
    # 这里可以添加更复杂的逻辑来匹配任务和合适的仓库
    # 现在简单随机返回一个
    description = "1. 小非的中间结果输出"
    
    return jsonify({"description": description})

@app.route('/api/project_summary', methods=['POST'])
def project_summary():
    """Generate a hierarchical summary of a project directory"""
    data = request.json
    project_path = data.get('project_path', '')
    
    if not project_path or not os.path.exists(project_path):
        return jsonify({"error": "Invalid project path"}), 400
    
    # Build directory tree string
    dir_tree = ""
    for root, dirs, files in os.walk(project_path):
        level = root.replace(project_path, '').count(os.sep)
        indent = ' ' * 4 * level
        dir_tree += f'{indent}{os.path.basename(root)}/\n'
        subindent = ' ' * 4 * (level + 1)
        for file in files:
            dir_tree += f'{subindent}{file}\n'

    # Prepare prompt for the model
    prompt = f"""下面是一个项目的目录树结构。请提供两层的层次化功能摘要，技术架构，和别人使用的评价。功能摘要使用编号部分（1、1.1）来描述项目结构和每个主要组件的功能。重点关注项目的组织结构和不同目录/文件的用途。

目录树：
{dir_tree}

请提供详细的两层层次化功能摘要，技术架构，和别人使用的评价："""

    # Call Ollama API
    try:
        response = requests.post(
            'http://10.129.164.27:11434/api/generate',
            json={
                'model': 'deepseek-r1:32b',
                'prompt': prompt,
                'stream': False
            }
        )
        response.raise_for_status()
        summary = response.json().get('response', '')
        return jsonify({"summary": summary})
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Failed to connect to Ollama API: {str(e)}"}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)
