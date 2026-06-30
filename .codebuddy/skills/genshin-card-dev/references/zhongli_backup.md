# 钟离技能原代码备份

> 备份时间：2026-06-25
> 备份原因：准备对钟离三技能进行重大改动前存档

## addZhongliSkills

```typescript
private addZhongliSkills(skills: SkillInfo[], player: PlayerState, ctx: GameContextSnapshot): void {
    const data = this.getData(player.id);
    skills.push({
      id: 'zhongli_contract',
      name: '契约',
      description: '回合开始时，可将1枚"玉璋"标记交给一名其他角色建立契约关系。',
      type: 'active',
      usable: (p, c) => data.jadeCount >= 1 && p.id === (c.currentPlayerId),
    });
    skills.push({
      id: 'zhongli_jade',
      name: '玉璋',
      description: '锁定技：每轮开始增加2枚标记(上限4)。拥有标记的角色受伤害时移去1枚抵消1点伤害。',
      type: 'passive',
      usable: () => false,
    });
    skills.push({
      id: 'zhongli_leisure',
      name: '闲游',
      description: '出牌阶段限一次，弃置2枚玉璋与场上任意一名其他角色交换座位。',
      type: 'active',
      usable: (p, c) => (data.jadeCount || 0) >= 2 && !data.leisureUsedThisTurn && p.id === (c.currentPlayerId),
    });
  }
```

## onRoundStart (玉璋标记获取)

```typescript
async onRoundStart(): Promise<void> {
    for (const p of this.allPlayers) {
      if (p.isDead) continue;
      const data = this.getData(p.id);
      if (p.heroId === 'zhongli') {
        data.jadeCount = Math.min(4, (data.jadeCount || 0) + 2);
        this.eventBus.emit(GameEvent.Log, {
          message: `【玉璋】${p.name} 获得2枚玉璋标记（共${data.jadeCount}枚）。`
        });
        VoiceManager.getInstance().playSkillVoice('zhongli', '玉璋', p.id);
      }
      if (p.heroId === 'alhaitham') {
        data.actingUsedThisRound = false;
      }
      if (p.heroId === 'citlali') {
        data.shamanUsedThisRound = false;
      }
    }
  }
```

## 契约 (zhongliContract)

```typescript
private async zhongliContract(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length === 0) return false;
    if ((data.jadeCount || 0) < 1) return false; // 需要至少1枚玉璋标记

    const driver = this.drivers.get(player.id)!;
    const useContract = await (driver as any).promptYesNo?.(
      `【契约】是否消耗1枚玉璋标记，与一名其他角色建立契约关系？（剩余${data.jadeCount || 0}枚）`
    ) ?? false;
    if (!useContract) return false;

    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '契约-选择角色', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    data.jadeCount--;
    data.contractPartnerId = target.id;
    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 与 ${target.name} 建立【契约】关系，可互相使用对方手牌。`
    });
    VoiceManager.getInstance().playSkillVoice('zhongli', '契约', player.id);
    return true;
  }
```

## 闲游 (zhongliLeisure)

```typescript
private async zhongliLeisure(player: PlayerState, ctx: GameContextSnapshot): Promise<boolean> {
    const data = this.getData(player.id);
    const aliveOthers = getAlivePlayers(this.allPlayers).filter(p => p.id !== player.id);
    if (aliveOthers.length === 0) return false;

    const driver = this.drivers.get(player.id)!;
    const targetId = await driver.promptTarget(player, aliveOthers.map(p => p.id), '闲游-交换座位', ctx);
    if (targetId === null) return false;
    const target = aliveOthers.find(p => p.id === targetId)!;

    data.jadeCount = (data.jadeCount || 0) - 2;
    data.leisureUsedThisTurn = true;

    // 迁都式交换：将钟离从当前位置移除，插入到目标位置
    const pi = this.allPlayers.indexOf(player);
    this.allPlayers.splice(pi, 1);
    const tiNew = this.allPlayers.indexOf(target);
    this.allPlayers.splice(tiNew + 1, 0, player);

    this.eventBus.emit(GameEvent.Log, {
      message: `${player.name} 发动【闲游】，与 ${target.name} 交换了座位！`
    });
    VoiceManager.getInstance().playSkillVoice('zhongli', '闲游', player.id);
    return true;
  }
```

## 玉璋抵消伤害 (onJadeProtect)

```typescript
onJadeProtect(player: PlayerState, damage: number): number {
    const data = this.getData(player.id);
    let remaining = damage;
    while (remaining > 0 && (data.jadeCount || 0) > 0) {
      data.jadeCount--;
      remaining--;
      this.eventBus.emit(GameEvent.Log, {
        message: `【玉璋】${player.name} 移去1枚标记抵消1点伤害。（剩余${data.jadeCount}枚）`
      });
      VoiceManager.getInstance().playSkillVoice('zhongli', '玉璋', player.id);
    }
    return remaining;
  }
```

## resetTurnFlags (钟离部分)

```typescript
// 在 resetTurnFlags 中：
case 'zhongli':
    data.leisureUsedThisTurn = false;
    break;
```

## onTurnStart (钟离契约触发)

```typescript
// 在 onTurnStart 中：
case 'zhongli': await this.zhongliContract(player, ctx); break;
```

## executeActiveSkill 路由

```typescript
case 'zhongli_contract': return await this.zhongliContract(player, ctx);
case 'zhongli_leisure': return await this.zhongliLeisure(player, ctx);
```
