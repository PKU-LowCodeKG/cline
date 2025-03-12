export interface RepoInfo {
	clone_url: string
	full_name: string
	html_url: string
	readme: string
	recommendations: string[]
	risks: string[]
	score: number
	ssh_url: string
	strengths: string[]
	url: string
}

export const buildRepoInfoString = (repo: RepoInfo): string => {
    let repoInfoString = `
项目名称：${repo.full_name}
仓库地址：${repo.html_url}
推荐评分：${repo.score}
优势：${repo.strengths.join("、")}
风险：${repo.risks.join("、")}
总体建议：${repo.recommendations.join("、")}

下面是该项目的详细描述：
${repo.readme.slice(12, -3)}

---
`
	return repoInfoString
}

export const DefaultData: RepoInfo[] = [
    {
        "score": 95,
        "strengths": [
            "基于Spring Boot的开发框架",
            "内置用户管理、权限管理和日志系统等常用功能",
            "支持前后端分离架构和灵活扩展机制"
        ],
        "risks": [
            "项目星标数较少，社区活跃度可能不高"
        ],
        "recommendations": [
            "建议检查项目的更新频率和维护情况",
            "考虑是否有其他更活跃的类似项目作为备选方案"
        ],
        "full_name": "TaleLin/lin-cms-spring-boot",
        "url": "https://api.github.com/repos/TaleLin/lin-cms-spring-boot",
        "html_url": "https://github.com/TaleLin/lin-cms-spring-boot",
        "clone_url": "https://github.com/TaleLin/lin-cms-spring-boot.git",
        "ssh_url": "git@github.com:TaleLin/lin-cms-spring-boot.git",
        "readme": "```markdown\n## 项目简介\n\n**Lin-CMS-Spring-boot** 是基于 **Spring Boot** 和 **MyBatis-Plus** 实现的内容管理系统（CMS）后端框架，旨在帮助开发者高效构建 CMS 系统。它内置了用户管理、权限管理和日志系统等常用功能，并支持前后端分离架构和灵活的扩展机制。\n\n## 核心功能\n- 前后端分离架构，支持多种前端实现\n- 内置 CMS 常用功能（用户管理、权限管理、日志系统）\n- 支持通过 `extension` 灵活扩展业务\n\n## 技术栈\n- **框架**：Spring Boot 2.5.2, MyBatis-Plus 3.4.1\n- **开发规范**：基于 Lin CMS 开发规范\n- **工具**：MIT 许可证，支持文档和开发规范\n\n## 开源协议\n[MIT](LICENSE) © 2021 林间有风\n```"
    },
    {
        "score": 95,
        "strengths": [
            "基于Spring Boot的博客系统完全匹配用户需求",
            "支持第三方登录和云存储等额外功能"
        ],
        "risks": [
            "项目Star数较少，可能社区活跃度不高"
        ],
        "recommendations": [
            "检查依赖项与现有环境的兼容性",
            "评估社区活跃度和维护情况"
        ],
        "full_name": "iszhouhua/blog",
        "url": "https://api.github.com/repos/iszhouhua/blog",
        "html_url": "https://github.com/iszhouhua/blog",
        "clone_url": "https://github.com/iszhouhua/blog.git",
        "ssh_url": "git@github.com:iszhouhua/blog.git",
        "readme": "```markdown\n## 项目简介  \n这是一个基于**Spring Boot**和**Vue.js**的个人博客系统，支持多种云存储、第三方登录（如Gitee、GitHub）以及数据库版本管理。项目提供评论管理、用户模块重做等功能，并通过**Flyway**实现数据库脚本自动运行。\n\n## 核心功能  \n- **云存储支持**：集成七牛云、阿里云、腾讯云等存储服务  \n- **第三方登录**：支持Gitee和GitHub账号登录  \n- **数据库管理**：使用Flyway进行版本控制，简化数据库结构修改  \n\n## 技术栈  \n- **后端框架**：Spring Boot, MyBatis, Flyway  \n- **前端工具**：Vue.js, Element UI  \n- **其他工具**：MySQL, Redis, Caffeine  \n\n## 开源协议  \nMIT License\n```"
    },
    {
        "score": 92,
        "strengths": [
            "核心功能匹配度高，覆盖了文章管理、评论管理和系统配置等主要需求",
            "技术栈与Spring Boot框架兼容性良好，使用主流的技术如MyBatis-Plus和layui"
        ],
        "risks": [
            "项目star数为319，社区认可度一般，可能影响长期维护和支持",
            "README中未明确说明开源协议，可能存在法律风险"
        ],
        "recommendations": [
            "建议检查项目的活跃度和维护情况，确保能够获得持续的支持",
            "建议在使用前与项目作者确认开源协议，避免潜在的法律问题"
        ],
        "full_name": "ZHENFENG13/My-Blog-layui",
        "url": "https://api.github.com/repos/ZHENFENG13/My-Blog-layui",
        "html_url": "https://github.com/ZHENFENG13/My-Blog-layui",
        "clone_url": "https://github.com/ZHENFENG13/My-Blog-layui.git",
        "ssh_url": "git@github.com:ZHENFENG13/My-Blog-layui.git",
        "readme": "```markdown\n## 项目简介  \n**My-Blog-Layui** 是一个基于 Spring Boot 技术栈的个人博客系统，由原 **My-Blog** 项目二次开发而来。该项目采用 **layui** 框架重构了后台管理界面和分页、评论功能，支持文章发布、评论管理和系统配置等功能，适合用于学习和实践 Spring Boot 开发。\n\n## 核心功能  \n- **文章管理**：支持文章的增删改查及分类管理  \n- **评论管理**：提供评论审核、删除及统计功能  \n- **系统配置**：可自定义网站基础信息、友情链接等  \n\n## 技术栈  \n- **后端框架**：Spring Boot, MyBatis-Plus  \n- **前端框架**：layui, Editor.md  \n- **数据库**：MySQL (Druid 数据源)  \n- **开发工具**：Lombok  \n\n## 开源协议  \n未明确说明，建议参考原项目开源协议。"
    },
    {
        "score": 87,
        "strengths": [
            "核心功能匹配度高，覆盖了用户管理、文章发布和评论互动等需求",
            "技术栈成熟且广泛使用，包括Spring Boot、Hibernate、MySQL和Bootstrap4"
        ],
        "risks": [
            "项目健康度较低，仅有1641个star，社区活跃度可能不高"
        ],
        "recommendations": [
            "建议检查项目的依赖项是否与现有环境兼容",
            "考虑项目的维护情况和更新频率"
        ],
        "full_name": "Raysmond/SpringBlog",
        "url": "https://api.github.com/repos/Raysmond/SpringBlog",
        "html_url": "https://github.com/Raysmond/SpringBlog",
        "clone_url": "https://github.com/Raysmond/SpringBlog.git",
        "ssh_url": "git@github.com:Raysmond/SpringBlog.git",
        "readme": "```markdown\n## 项目简介  \nSpringBlog 是一个基于 **Spring Boot** 的简洁设计博客系统，支持用户管理、文章发布和评论互动等功能。它是作者用于学习 Spring Boot 特性的一个实践项目，提供完整的开发和部署文档。\n\n## 核心功能  \n- 用户注册与登录（支持角色权限控制）  \n- 文章创作与发布（支持 Markdown 和代码高亮）  \n- 评论管理与互动  \n\n## 技术栈  \n**后端框架**: Spring Boot、Spring MVC、Spring JPA、Spring Security  \n**数据库**: MySQL (Hibernate)、Redis (缓存)  \n**前端工具**: Bootstrap、ACE Editor、Pegdown（Markdown 处理）  \n**构建工具**: Gradle、Bower  \n\n## 开源协议  \nModified BSD license. Copyright (c) 2015 - 2018, Jiankun LEI (Raysmond).  \n```"
    },
    {
        "score": 85,
        "strengths": [
            "核心功能匹配度高，包括Markdown文件导入、Hexo路径兼容以及后台管理工具",
            "技术栈与Spring Boot框架完全兼容"
        ],
        "risks": [
            "项目健康度较低，仅有883个star，社区支持可能有限",
            "依赖项中使用的是Spring Boot 1.5版本，可能存在兼容性问题"
        ],
        "recommendations": [
            "建议检查并升级到最新的Spring Boot版本以确保兼容性和安全性",
            "考虑项目的维护情况和社区活跃度，评估是否需要长期支持"
        ],
        "full_name": "caozongpeng/SpringBootBlog",
        "url": "https://api.github.com/repos/caozongpeng/SpringBootBlog",
        "html_url": "https://github.com/caozongpeng/SpringBootBlog",
        "clone_url": "https://github.com/caozongpeng/SpringBootBlog.git",
        "ssh_url": "git@github.com:caozongpeng/SpringBootBlog.git",
        "readme": "```markdown\n## 项目简介  \nKyrie Blog是一个基于**SpringBoot 1.5 + MyBatis + Thymeleaf**实现的个人博客系统，支持Markdown文件导入、Hexo路径兼容以及后台管理功能。该项目旨在帮助**Spring Boot初学者**快速上手，并为需要高效管理文章的写作者提供便捷工具。\n\n## 核心功能  \n- **Markdown文件导入**：支持将本地Markdown文件直接导入博客系统  \n- **Hexo路径兼容**：模仿Hexo生成的访问路径，方便用户迁移  \n- **后台管理工具**：提供文章发布、分类管理及设置等功能  \n\n## 技术栈  \n- **后端**：SpringBoot, MyBatis, Thymeleaf, PageHelper, Ehcache, Commonmark  \n- **前端**：Jquery, Bootstrap, editor.md, dropzone, sweetalert  \n- **第三方服务**：七牛云（文件上传）、百度统计  \n\n## 开源协议  \n未提及具体开源协议\n```"
    },
]