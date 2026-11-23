/** 初始化演示数据（幂等）：npm run seed */
import { migrate, one, run, meta } from './db.js';
import { toJson } from './util.js';
import { cuid } from './util.js';
import { hashPassword } from './auth.js';
import { nowIso } from './util.js';

const TABLES = ['users'];

const SAMPLE_RESUME = `张伟 · 后端开发工程师（Node.js）
电话：138****0000 ｜ 邮箱：zhangwei@example.com ｜ 北京

【教育】
2015-2019 北京大学 计算机科学与技术 本科

【技能】
语言：JavaScript/TypeScript、Java（熟练）、Go（了解）
框架：Node.js（NestJS/Fastify）、Spring Boot
存储：MySQL（索引优化、分库分表）、Redis（缓存/分布式锁）
中间件：Kafka、RabbitMQ
工程：Docker、Kubernetes、CI/CD、Prometheus + Grafana

【工作经历】
2021-至今 某电商平台 · 高级后端工程师
- 负责订单链路（下单/支付回调/履约），qps 峰值 8000，P99 110ms
- 主导订单超时关单改造：从定时轮询改为延迟消息 + 幂等消费，重复关单率 0.3% → 0
- 支付回调链路重构：加唯一键与状态机，重复到账问题清零
- 搭建链路压测体系，找出连接池与慢查询两个瓶颈，P99 从 800ms 降到 120ms

2019-2021 某 SaaS 公司 · 后端工程师
- 负责权限与账号体系，RBAC + 多租户隔离
- 用 Redis 实现分布式锁与限流，替换单机锁，避免跨实例重复执行

【项目】
1. 票务风控系统（2024）：Flink 实时特征计算，设备指纹 + 秒级滑动窗口，黄牛识别率 62% → 91%，日均拦截 12 万单
2. 订单履约中台：拆单、合单、库存预占，SLA 99.95%

【自我评价】
习惯先把口径和数据对齐，再动手改代码；线上问题从日志和链路耗时入手，先定位再优化。`;

const QUESTIONS = [
  ['MySQL 索引为什么使用 B+ 树而不是 B 树？', 'B+ 树非叶子节点只存索引、扇出更大，树更矮；叶子节点串成链表，范围查询和排序更友好。', '字节跳动', ['数据库'], 96],
  ['什么情况下会发生回表？怎么避免？', '二级索引拿不到查询需要的列时，要回主键索引再查一次。避免方式：覆盖索引、把常用列放进联合索引。', '美团', ['数据库'], 88],
  ['Redis 是单线程的，为什么还这么快？', '纯内存操作、IO 多路复用、单线程避免锁竞争与上下文切换；慢通常来自大 key、热 key 或阻塞命令（keys、flushall）。', '阿里巴巴', ['缓存'], 92],
  ['缓存穿透、击穿、雪崩分别怎么处理？', '穿透：布隆过滤器 + 空值缓存；击穿：热点 key 加互斥锁或本地缓存；雪崩：过期时间打散 + 多级缓存 + 熔断降级。', '腾讯', ['缓存'], 90],
  ['Kafka 如何保证消息不丢失、不重复消费？', '不丢：acks=all + 副本 + 关闭 unclean 选举；不重复：消费端幂等（唯一键/状态机），事务或手动提交位点。', '快手', ['消息队列'], 85],
  ['分布式锁有哪些实现？各自的问题？', 'Redis：SETNX + 过期 + 续期（Redlock 有争议）；ZooKeeper：临时顺序节点；DB：唯一索引。注意锁误删、脑裂、续期失败。', '拼多多', ['分布式'], 87],
  ['接口 P99 突然从 200ms 涨到 2s，你怎么排查？', '先看监控定位是流量、依赖还是自身；再看慢日志/链路耗时/GC/连接池；最后看是否发布或缓存失效导致回源。', '字节跳动', ['性能'], 94],
  ['HTTP/2 解决了队头阻塞吗？', '解决了 HTTP 层的队头阻塞（多路复用），但 TCP 层丢包仍会阻塞整个连接，QUIC 才彻底解决。', '百度', ['网络'], 78],
  ['说说你对幂等的理解，怎么设计？', '同一请求执行多次结果一致。设计：唯一键去重表、状态机只允许单向流转、业务 token、消费端幂等表。', '京东', ['分布式'], 86],
  ['数据库事务隔离级别与幻读的关系？', 'RR 下 MySQL 用 MVCC + 间隙锁防幻读；RC 只有 MVCC 快照读，当前读仍可能幻读。', '美团', ['数据库'], 80],
  ['为什么用消息队列？会带来什么问题？', '解耦、削峰、异步。问题：重复消费、顺序性、消息积压、最终一致性、运维成本。', '小米', ['消息队列'], 76],
  ['如何设计一个高并发秒杀系统？', '分层限流（网关/应用）、库存预热到 Redis + Lua 原子扣减、异步下单、幂等、防刷与验证码、DB 最终扣减。', '阿里巴巴', ['系统设计'], 89],
  ['微服务拆分的边界怎么定？', '按业务能力与团队边界拆，避免分布式事务；先单体模块化，等吞吐或组织需要再拆。', '字节跳动', ['架构'], 72],
  ['线上 Full GC 频繁，怎么处理？', '看 GC 日志与堆 dump，判断是内存泄漏还是参数不合理；缩短对象生命周期、调堆比例、换 G1/ZGC。', '腾讯', ['JVM'], 74],
  ['如何保证缓存与数据库的一致性？', '先更新库再删缓存 + 延迟双删 + 订阅 binlog 异步补偿；强一致场景直接读库或加分布式锁。', '美团', ['缓存'], 84],
  ['TCP 三次握手为什么不是两次？', '防止历史连接请求造成的资源浪费与状态错乱，两次无法确认客户端接收能力。', '华为', ['网络'], 70],
  ['索引失效的常见原因？', '函数/表达式作用在索引列、隐式类型转换、like 前缀模糊、or 中有一侧无索引、联合索引不满足最左前缀。', '百度', ['数据库'], 82],
  ['线程池核心参数与拒绝策略怎么选？', '核心线程数按 CPU/IO 密集定，队列有界，拒绝策略按业务选丢弃/调用方执行/自定义降级。', '京东', ['并发'], 75],
  ['如何做接口幂等和防重放？', '幂等键 + 去重表 + 状态机；防重放用时间戳 + nonce + 签名，服务端缓存 nonce。', '快手', ['安全'], 68],
  ['Linux 上 CPU 飙高怎么排查？', 'top 找进程 → top -Hp 找线程 → printf %x 转 16 进制 → jstack 查栈；或 perf/火焰图。', '滴滴', ['运维'], 73],
  ['你如何设计一个短链服务？', '发号器（号段/雪花）+ 62 进制转换 + 布隆过滤器防穿透 + 缓存热点 + 301/302 选择。', '微博', ['系统设计'], 77],
  ['说一下你对 CAP 的理解。', '分布式系统无法同时满足一致性、可用性、分区容错；P 必须容忍，实际在 C 与 A 之间取舍（BASE/最终一致）。', '阿里巴巴', ['分布式'], 71],
  ['Redis 持久化 RDB 与 AOF 怎么选？', 'RDB 快、恢复快但可能丢数据；AOF 更安全但文件大、恢复慢；生产常用混合持久化。', '腾讯', ['缓存'], 69],
  ['如何避免消息重复消费带来的副作用？', '消费端幂等表 + 唯一键 + 业务状态机；必要时用事务消息或本地消息表。', '美团', ['消息队列'], 67],
  ['为什么数据库要分库分表？有什么代价？', '单库容量与连接数瓶颈；代价是跨库事务、分页、聚合、扩容与运维复杂度。', '京东', ['数据库'], 66],
  ['如何做灰度发布和回滚？', '按流量/用户维度切流，双版本并存，指标看板 + 自动熔断，回滚脚本与数据兼容设计。', '字节跳动', ['工程'], 64],
  ['说一下 React 的 diff 算法。', '同层比较、key 复用、类型不同直接替换；时间复杂度 O(n)。', '快手', ['前端'], 60],
  ['前端如何做性能优化？', '减少首屏体积（分包/懒加载）、图片与字体优化、缓存策略、减少重排重绘、预加载关键资源。', '小红书', ['前端'], 58],
  ['HTTP 缓存头有哪些？优先级如何？', 'Cache-Control > Expires；协商缓存 ETag/Last-Modified；no-store 最高优先。', '百度', ['网络'], 56],
  ['手写 debounce 并说明与 throttle 的区别。', 'debounce 等停止触发后执行；throttle 固定频率执行。两者都要保留 this 与参数。', '小米', ['前端'], 54],
  ['SQL 求每月环比增长怎么写？', '用窗口函数 LAG 取上月值，再算百分比；注意缺失月份与口径（已支付）。', '美团', ['SQL'], 52],
  ['二叉树层序遍历怎么写？', 'BFS + 队列，按层收集；时间 O(n)，空间 O(最宽层)。', '腾讯', ['算法'], 50],
  ['反转链表有几种写法？', '迭代（三指针）与递归；迭代空间 O(1)，注意保存 next。', '字节跳动', ['算法'], 48],
  ['快排的平均与最坏复杂度？如何避免最坏？', '平均 O(nlogn)，最坏 O(n²)；随机化 pivot 或三数取中可大幅降低概率。', '阿里巴巴', ['算法'], 46],
  ['稳定排序有哪些？为什么需要稳定？', '归并、插入、冒泡；多关键字排序时保持前一次顺序有意义。', '华为', ['算法'], 44],
  ['分布式 ID 生成方案对比？', 'UUID（无序）、数据库自增（单点）、号段模式、雪花（时钟回拨问题）、Leaf。', '滴滴', ['分布式'], 42],
  ['如何排查内存泄漏？', '堆快照对比、监控 RSS 趋势、看对象引用链；Node 可用 --inspect + heap snapshot。', '腾讯', ['性能'], 40],
  ['你期望的薪资是多少？', '参考行情与现包，给出区间并说明可谈空间。', '通用', ['HR'], 20],
  ['你还有什么想问我的？', '问团队目标、考核口径、技术演进方向。', '通用', ['HR'], 18],
];

const LIBRARIES = [
  {
    name: '后端开发高频八股（官方）',
    description: '数据库 / 缓存 / 消息队列 / 分布式 四类核心题，答案口径统一',
    category: 'backend',
    entries: [
      ['MySQL 一条 SQL 的执行流程？', '连接器 → 解析器 → 优化器 → 执行器 → 存储引擎；优化器决定索引与 join 顺序。'],
      ['explain 里哪些字段最关键？', 'type（访问类型）、key（实际索引）、rows（扫描行数）、Extra（是否 filesort/临时表/回表）。'],
      ['事务的四大特性如何实现？', '原子性 undo log、持久性 redo log、隔离性锁 + MVCC、一致性由前三者共同保证。'],
      ['Redis 常见数据结构与使用场景？', 'String 计数/缓存、Hash 对象、List 队列、Set 去重、ZSet 排行榜/延时队列。'],
      ['如何用 Redis 实现延时队列？', 'ZSet 存到期时间戳，轮询取到期元素；或用 Stream + 消费者组。'],
      ['Kafka 的 ISR 是什么？', '与 leader 保持同步的副本集合；leader 挂掉从 ISR 选新 leader，保证不丢已提交消息。'],
      ['如何保证最终一致性？', '本地消息表 / 事务消息 + 重试 + 对账补偿；消费端幂等。'],
    ],
  },
  {
    name: '系统设计与高并发（官方）',
    description: '秒杀、短链、feed、限流等设计题的标准答法',
    category: 'system-design',
    entries: [
      ['秒杀系统的核心链路？', '前端限流 → 网关鉴权 → Redis 预扣库存（Lua 原子）→ 异步下单 → DB 最终扣减 → 失败补偿。'],
      ['如何设计一个限流器？', '计数器（固定窗口）、滑动窗口、令牌桶、漏桶；分布式用 Redis + Lua 保证原子。'],
      ['短链服务的关键点？', '发号器 + 62 进制、布隆过滤器、热点缓存、301/302 选择、防爬。'],
      ['Feed 流推拉怎么选？', '写扩散（推）适合读多、粉丝少；读扩散（拉）适合大 V；混合按粉丝量分档。'],
    ],
  },
  {
    name: '行为面试与 HR 题（官方）',
    description: '动机、稳定性、冲突处理、谈薪的标准答法',
    category: 'behavior',
    entries: [
      ['为什么离开上一家公司？', '说成长与业务匹配，不说前公司坏话；把动机落在「想做什么」。'],
      ['你最大的缺点是什么？', '给真实但可控的缺点 + 已经在改进的具体动作。'],
      ['和同事有分歧怎么处理？', '先对齐目标与数据，再列方案取舍，最后请上级拍板并复盘。'],
      ['期望薪资怎么谈？', '给区间 + 依据（行情、现包、岗位范围），表达可谈空间。'],
    ],
  },
];

export function seed() {
  migrate();
  const hasUser = one('SELECT 1 FROM users LIMIT 1');
  if (hasUser) {
    console.log('[seed] 已存在数据，跳过');
    return;
  }
  const now = nowIso();
  const uid = cuid();
  run(
    `INSERT INTO users(id,phone,password_hash,country_code,last_interview_lang,sub_level,sub_expire_at,
      interview_time,mock_interview_count,question_prediction_count,credits,interview_preference,
      exam_customization,client_settings,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid, '13800000000', hashPassword('demo1234'), 'CN', 'zh-CN', 'TRIAL', null,
    30, 3, 2, 0, toJson({ answerStyle: 'natural', assistMode: true, turnCards: true }),
    toJson({ preset: 'quicksort-complexity', codeQuality: 'standard', customRequirements: '', showReasoning: true }),
    toJson({ locale: 'zh-CN', theme: 'light' }), now,
  );
  run('INSERT INTO voiceprints(user_id,enrolled,status) VALUES(?,0,?)', uid, 'available');

  const rid = cuid();
  run('INSERT INTO resumes(id,user_id,title,content,is_sample,created_at) VALUES(?,?,?,?,?,?)',
    rid, uid, '张伟-后端开发（示例）', SAMPLE_RESUME, 1, now);

  const goals = [
    ['后端开发（示例）', '字节跳动', '负责订单/履约等核心链路研发；要求 3 年以上，熟悉 MySQL/Redis/Kafka，有高并发与稳定性经验。'],
    ['Node.js 后端（示例）', '小红书', '负责内容业务 API 与中台服务；TypeScript + Node.js 为主，重视性能与工程质量。'],
  ];
  const goalIds = [];
  for (const [name, company, desc] of goals) {
    const gid = cuid();
    goalIds.push(gid);
    run('INSERT INTO goals(id,user_id,name,company_name,description,custom_hot_words,created_at) VALUES(?,?,?,?,?,?,?)',
      gid, uid, name, company, desc,
      toJson(['微服务', '高并发', 'MySQL', 'Redis', 'Kafka', '幂等', '分布式锁', 'P99', '缓存一致性', '订单链路', '分库分表', '限流']), now);
  }

  const mid = cuid();
  run('INSERT INTO materials(id,user_id,name,content,created_at) VALUES(?,?,?,?,?)',
    mid, uid, '项目独特事实',
    '2024 年在票务风控系统主导实时特征计算：Flink + 设备指纹 + 秒级滑动窗口，黄牛识别率从 62% 提升到 91%，日均拦截 12 万单。订单履约中台 SLA 99.95%，P99 110ms。', now);
  run('INSERT INTO material_entries(id,material_id,question,answer,source,created_at) VALUES(?,?,?,?,?,?)',
    cuid(), mid, '票台风控系统的核心指标？', '识别率 62%→91%，日均拦截 12 万单，Flink 实时特征 + 设备指纹 + 秒级滑动窗口。', 'manual', now);

  for (const q of QUESTIONS) {
    run('INSERT INTO questions(id,question_text,answer,company,options,tags,difficulty,hot,asked_count,locked,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      cuid(), q[0], q[1], q[2], toJson([]), toJson(q[3]), 'medium', q[4] > 80 ? 1 : 0, q[4], 0, now);
  }

  for (const lib of LIBRARIES) {
    const lid = cuid();
    run('INSERT INTO official_libraries(id,name,description,category,entry_count,created_at) VALUES(?,?,?,?,?,?)',
      lid, lib.name, lib.description, lib.category, lib.entries.length, now);
    for (const [q, a] of lib.entries) {
      run('INSERT INTO official_library_entries(id,library_id,question,answer) VALUES(?,?,?,?)', cuid(), lid, q, a);
    }
  }

  run('INSERT INTO announcements(id,platform,title,content,active,created_at) VALUES(?,?,?,?,?,?)',
    cuid(), 'windows', '本地独立环境', '本实例为面试橙：数据全部保存在 ./data，AI 走本地 mock 大脑，可在 .env 切换到任意 OpenAI 兼容网关。', 1, now);

  run('INSERT INTO notices(id,user_id,kind,payload,ack,created_at) VALUES(?,?,?,?,?,?)',
    cuid(), uid, 'usage-ack', toJson({ text: '本工具用于模拟面试与笔试练习，请在合规场景下使用。', countdownSec: 5 }), 0, now);

  meta.set('seed_at', now);
  meta.set('schema_version', '1');
  console.log(`[seed] 完成：user=13800000000/demo1234，简历 1，岗位 ${goals.length}，题库 ${QUESTIONS.length}，官方库 ${LIBRARIES.length}`);
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) seed();
