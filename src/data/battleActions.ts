
export const actionGroupOrder = [
  '投骰与移动',
  '方向选择',
  '出牌',
  '对局操作',
  '商店购买',
  '怪物突击',
  '地块与事件',
  '其它',
] as const

export type ActionGroup = (typeof actionGroupOrder)[number]

export type Control =
  | { kind: '无' }
  | { kind: '开关'; field: string; on: string; off: string }
  | { kind: '数字'; field: string; name: string; defaultValue?: number; hint?: string }
  | { kind: '节点'; field: string; multiSelect?: boolean; allNodes?: boolean }
  | { kind: '玩家'; field: string; multiSelect?: boolean }
  | { kind: '怪物'; field: string }
  | { kind: '卡'; field: string; candidates?: string }
  | { kind: '手牌'; field: string; multiSelect?: boolean }
  | { kind: '整数多选'; field: string; candidates?: string }
  | { kind: '整数单选'; field: string; candidates?: string }

export interface actionSpec {
  name: string
  detail: string
  group: ActionGroup
  Control: Control[]
}

export const actionSpecTable: Record<string, actionSpec> = {
  ThrowDiceC2S: {
    name: '投骰子',
    detail:
      '开始移动的骰子。`Data` 里预填了 `IsNoOper` 或 `IsMoveNow` 时表示这步不用你决定，' +
      '客户端会**自动回**（这里也可以手动点）。`DevPoint` 是调试用指定点数，0 = 随机。',
    group: '投骰与移动',
    Control: [
      { kind: '无' },
      { kind: '数字', field: 'DevPoint', name: '指定点数(调试)', defaultValue: 0, hint: '0 = 随机' },
    ],
  },
  MoveAgainC2S: {
    name: '再移动一次',
    detail: '地块效果给的额外移动。服务端下发这个候选时客户端会**自动回**。',
    group: '投骰与移动',
    Control: [{ kind: '数字', field: 'DevPoint', name: '指定点数(调试)', defaultValue: 0 }],
  },
  ThrowDiceResultC2S: {
    name: '上报骰子结果',
    detail:
      '「遥控骰子」道具生效时，本地掷完把结果告诉服务端。**只发 `Point`**' +
      '（`MaxPoint` 是服务端预填的骰子上限，只用来算范围，客户端不回）。',
    group: '投骰与移动',
    Control: [{ kind: '数字', field: 'Point', name: '点数' }],
  },
  BombThrowDiceC2S: {
    name: '投炸弹骰',
    detail: '炸弹地块的骰子。',
    group: '投骰与移动',
    Control: [{ kind: '数字', field: 'DevPoint', name: '指定点数(调试)', defaultValue: 0 }],
  },
  EventThrowDiceC2S: {
    name: '事件投骰',
    detail:
      '事件要求的掷骰。**注意：本版本客户端从不发这条**（事件骰子由服务端自己掷，' +
      '只推 `EventThrowDiceS2C` 告诉大家结果），所以正常对局里不会出现这个待办。',
    group: '投骰与移动',
    Control: [
      { kind: '数字', field: 'EventId', name: '事件 id', defaultValue: 0 },
      { kind: '数字', field: 'DevPoint', name: '指定点数(调试)', defaultValue: 0 },
    ],
  },
  RollGoldC2S: {
    name: '掷金币',
    detail: '金币相关地块的掷骰。',
    group: '投骰与移动',
    Control: [{ kind: '数字', field: 'DevPoint', name: '指定点数(调试)', defaultValue: 0 }],
  },

  MoveC2S: {
    name: '移动',
    detail:
      '`Direction` 就是**目标节点号**（客户端 `RequestMoveC2S(sn, nextNodeId)` 只填它，' +
      '`ForceDir` / `LandEffect` / `Path` 都不发）。' +
      '服务端会在候选动作的 `Data` 里预填 `Direction` / `ForceDir` 作提示：' +
      '`ForceDir=true` 表示这个方向是强制的（开局第一回合就是这样），' +
      '不代表客户端要把它回传。',
    group: '方向选择',
    Control: [{ kind: '节点', field: 'Direction' }],
  },
  ChoiceDirectionC2S: {
    name: '选方向',
    detail:
      '岔路口选往哪走，`Direction` = 目标节点号。**本版本客户端从不发这条**' +
      '（岔路口走的是 `MoveC2S`），保留只是以防服务端真的下发这个候选。',
    group: '方向选择',
    Control: [
      { kind: '节点', field: 'Direction' },
      { kind: '数字', field: 'DevPoint', name: '指定点数(调试)', defaultValue: 0 },
    ],
  },

  UseEffectCardC2S: {
    name: '使用效果卡（场外）',
    detail:
      '从「可用卡」里挑一张（服务端预填的 `CanUseCardIds`）。需要指定目标时再点目标节点/玩家，' +
      '不点就是不指定。多效果的卡用 `UseSelectCardIndex` 选第几个效果（ 没做这个，这里补上了）。' +
      '**角色主动技能走的是同一条命令**：勾 `UseSkill`（`SkillId` 服务端预填了就带上）。' +
      '**有的技能必须选目标才能发动**，那就是 `TargetIds` —— 填玩家/怪物的 `Player.Id`，' +
      '捕获里的技能包就是 `UseSkill` + `SkillId=12302` + `TargetIds=[99991]` 三个字段。' +
      '若 `Data` 里预填了非 0 的 `CardId`（服务端指定要打这张），这条会被**自动发出去**，不用手点。',
    group: '出牌',
    Control: [
      { kind: '卡', field: 'CardId', candidates: 'CanUseCardIds' },
      { kind: '节点', field: 'TargetNodeIds', multiSelect: true, allNodes: true },
      { kind: '玩家', field: 'TargetIds', multiSelect: true },
      { kind: '数字', field: 'UseSelectCardIndex', name: '第几个效果', defaultValue: 0 },
      { kind: '开关', field: 'UseSkill', on: '用角色技能', off: '不用技能' },
      { kind: '数字', field: 'SkillId', name: '技能 id', defaultValue: 0 },
      { kind: '数字', field: 'DevPoint', name: '指定骰点(调试)', defaultValue: 0 },
    ],
  },
  UseQuickCardC2S: {
    name: '使用速用卡',
    detail: '响应别人动作时打出的速用卡。',
    group: '出牌',
    Control: [
      { kind: '卡', field: 'CardId', candidates: 'CanUseCardIds' },
      { kind: '玩家', field: 'TargetId' },
    ],
  },
  AbandonCardC2S: {
    name: '弃牌',
    detail: '`CardUniqueIds` 要的是**手牌唯一 id**（不是卡牌 id）。',
    group: '出牌',
    Control: [{ kind: '手牌', field: 'CardUniqueIds', multiSelect: true }],
  },

  BattleUseCardC2S: {
    name: '战斗用卡 / 准备OK',
    detail:
      '`CardUid` 是手牌唯一 id。**不选卡直接执行就是「准备 OK」**（ 的「准备OK」就是只发 Info）。',
    group: '对局操作',
    Control: [{ kind: '手牌', field: 'CardUid' }],
  },
  BattleChoiceC2S: {
    name: '战斗选择（防御 / 闪避）',
    detail:
      '「防御」「闪避」两个按钮就是这一条的 Dodge=0 / 1。' +
      '`DevPoint` 是指定战斗骰点（0 = 随机，1-6 = 指定）。' +
      '闪避成功与否看**对手的初始骰子**：对手掷 N，你至少要掷到 N+1（对手 5/6 时都是 6）。',
    group: '对局操作',
    Control: [
      { kind: '开关', field: 'Dodge', on: '闪避 (Dodge=1)', off: '防御 (Dodge=0)' },
      { kind: '数字', field: 'DevPoint', name: '指定骰点(调试)', defaultValue: 0 },
    ],
  },
  BattleThrowDiceC2S: {
    name: '战斗投骰',
    detail:
      '双方都「准备 OK」（5035 不带卡）之后，服务端把这一步推给攻方；' +
      '客户端只发 `Info{Sn}`（`DevPoint` 是调试用指定点数，正式流程不带）。' +
      '回完它战斗才继续（接着是 5039 防御/闪避选择）。',
    group: '对局操作',
    Control: [{ kind: '数字', field: 'DevPoint', name: '指定点数(调试)', defaultValue: 0 }],
  },
  AskBattleC2S: {
    name: '求战 / 放过',
    detail:
      '「攻击」「放过」两个按钮就是这一条的 IsBattle=1 / 0。' +
      '**只发 `IsBattle`**（要打谁由服务端按预填的候选决定，客户端不回传 `AskPlayerId`）。',
    group: '对局操作',
    Control: [{ kind: '开关', field: 'IsBattle', on: '开战 (IsBattle=1)', off: '放过 (IsBattle=0)' }],
  },
  StopOrContinueC2S: {
    name: '保障点：继续移动 / 停留',
    detail: ' 的「继续移动」「停留」就是这一条的 Stop=0 / 1。',
    group: '对局操作',
    Control: [{ kind: '开关', field: 'Stop', on: '停留 (Stop=1)', off: '继续移动 (Stop=0)' }],
  },
  SelectRelicC2S: {
    name: '选筹码',
    detail:
      '三选一筹码。`Relics`（候选筹码 id）/ `Lv` / `SupLv` 都是服务端在 `Data` 里预填的，' +
      '**客户端只回 `Idx`**（选第几个）；重抽则是**只发 `IsReroll=true`**，不带 `Idx`。',
    group: '对局操作',
    Control: [
      { kind: '数字', field: 'Idx', name: '第几个', defaultValue: 0 },
      { kind: '开关', field: 'IsReroll', on: '重抽', off: '不重抽' },
    ],
  },
  PursuitC2S: {
    name: '追击',
    detail:
      '选择追击谁（客户端 `LandPursuitWindow`：列表是**房间里别的玩家**，不是动作 `Data`）。' +
      '`SelectPlayerId` = 要追的玩家 id；**不追 / 离开** = 发 `SelectPlayerId=0`。',
    group: '对局操作',
    Control: [{ kind: '玩家', field: 'SelectPlayerId' }],
  },
  AskReviveTeammateC2S: {
    name: '复活队友',
    detail:
      '问你要不要复活队友。**只发 `IsRevive`**（复活谁、花多少金币都由服务端在 `Data` 里预填，客户端不回传）。',
    group: '对局操作',
    Control: [{ kind: '开关', field: 'IsRevive', on: '复活', off: '不复活' }],
  },
  SelectMechanismC2S: {
    name: '机关：是否启动',
    detail: '',
    group: '对局操作',
    Control: [{ kind: '开关', field: 'Select', on: '启动', off: '不启动' }],
  },
  GambleThrowDicC2S: {
    name: '赌博投骰',
    detail: '赌场里掷骰（`LandGambleWindow → StartGamble + GambleThrowDic`）。',
    group: '对局操作',
    Control: [{ kind: '数字', field: 'DevPoint', name: '指定点数(调试)', defaultValue: 0 }],
  },
  StartGambleC2S: {
    name: '赌场下注',
    detail:
      '赌场猜奇偶。`GuessCode`：**1 = 猜奇数、2 = 猜偶数**；`IsExec=false` 表示这次不参与（不发 `Hall`）。',
    group: '对局操作',
    Control: [
      { kind: '开关', field: 'IsExec', on: '开赌', off: '不赌' },
      { kind: '数字', field: 'GuessCode', name: '猜的号码' },
    ],
  },
  NotifyStoryC2S: {
    name: '推进剧情',
    detail: '`Index` = 剧情 id（对应候选动作 `Data` 里的值）。',
    group: '对局操作',
    Control: [{ kind: '数字', field: 'Index', name: '剧情序号' }],
  },

  ShopBuyC2S: {
    name: '商店购买（多人）',
    detail:
      'PVP 卡牌商店。**只发 `BuyCards`**（要买的货架下标，可多选）；' +
      '`Cards` / `Gold` / `Alreadys` / `FreeCard` 都是服务端预填的候选信息，客户端不回传，' +
      '本版本客户端也从不使用 `IsRemote`。',
    group: '商店购买',
    Control: [{ kind: '整数多选', field: 'BuyCards' }],
  },
  PVEShopBuyC2S: {
    name: '卡牌商店：买 / 关店 / 转账',
    detail:
      '三件事都走这条：**买** = `BuyCards` 填商品下标（0 起）；' +
      '**关店** = 只发 `IsClose=true`（`BuyCards` 留空）；' +
      '**ATM 转账** = `AssistPlayer` 填收款玩家 id（`BuyCards` 留空、`IsClose=false`）。',
    group: '商店购买',
    Control: [{ kind: '整数多选', field: 'BuyCards' }],
  },
  BuyRelicC2S: {
    name: '筹码商店：买 / 离开',
    detail: ' 的「购买」= Select=2 + Exit=1；「离开」= 只发 Exit=1。',
    group: '商店购买',
    Control: [
      { kind: '开关', field: 'Select', on: '买', off: '不买' },
      { kind: '开关', field: 'Exit', on: '离开', off: '继续逛' },
    ],
  },
  VendorBuyCardC2S: {
    name: '商贩处买卡',
    detail:
      '**只发 `IsBuy`**（买 / 不买）。`CardId` / `Gold` 是服务端在 `Data` 里预填的（它记录你要交易哪张），客户端不回传。',
    group: '商店购买',
    Control: [{ kind: '开关', field: 'IsBuy', on: '买', off: '不买' }],
  },

  MonsterPursuitC2S: {
    name: '怪物突击：选怪',
    detail: '`SelectId` 是候选怪物的玩家 id（ 就是取 `RoomPlayer.Id`）。',
    group: '怪物突击',
    Control: [{ kind: '怪物', field: 'SelectId' }],
  },

  TriggerEventC2S: { name: '确认（事件）', detail: '纯确认，不需要参数。', group: '地块与事件', Control: [] },
  TriggerDestinyC2S: { name: '确认（命运）', detail: '纯确认。', group: '地块与事件', Control: [] },
  TriggerHospitalC2S: { name: '确认（医院）', detail: '纯确认。', group: '地块与事件', Control: [] },
  TriggerDivinationC2S: {
    name: '占卜选牌',
    detail: '从 `CanChoiceIds` 里选一个。',
    group: '地块与事件',
    Control: [{ kind: '整数单选', field: 'Id', candidates: 'CanChoiceIds' }],
  },
  SelectEventC2S: {
    name: '选事件',
    detail: '从候选里选要触发的事件（多选），发 `Events`（服务端预填了候选）。',
    group: '地块与事件',
    Control: [{ kind: '整数多选', field: 'Events' }],
  },
  SelectRewardCardC2S: {
    name: '选奖励卡',
    detail:
      '三选一奖励卡（客户端 `ChooseRoundCardWindow` → `RequestRoundCard(sn, cardIds, index)`）。' +
      '`CardIds` = **服务端给的整份候选**（`Data.CardIds`），`Idx` = 你选的那张在候选里的下标。',
    group: '地块与事件',
    Control: [
      { kind: '整数多选', field: 'CardIds' },
      { kind: '数字', field: 'Idx', name: '第几个', defaultValue: 0 },
    ],
  },
  LandChoiceTargetC2S: {
    name: '选地块目标',
    detail:
      '地块要求选玩家/怪物时用（PVE 的选怪窗也走这条）。两种回法：' +
      '**选好了** = 只发 `TargetIds`；**退出不选** = 只发 `Exit=true`。' +
      '`LandType` / `TargetNum` / `CanTargetIds` 都是服务端预填的，客户端不回传。',
    group: '地块与事件',
    Control: [
      { kind: '玩家', field: 'TargetIds', multiSelect: true },
      { kind: '开关', field: 'Exit', on: '退出', off: '继续' },
    ],
  },
  LotteryChoiceC2S: {
    name: '彩票选号',
    detail:
      '**只发 `Vals`**（选中的号码，1-12 不重复）。`Num` 是服务端预填的注数，客户端不回传（注数 = 选了几个号）。',
    group: '地块与事件',
    Control: [{ kind: '整数多选', field: 'Vals' }],
  },
}

export function getActionSpec(commandName: string): actionSpec | undefined {
  return actionSpecTable[commandName]
}

export const urgentCommands = new Set([
  'BattleChoiceC2S',
  'AbandonCardC2S',
  'TriggerEventC2S',
  'SelectEventC2S',
  'TriggerHospitalC2S',
  'TriggerDestinyC2S',
])