#!/usr/bin/env python3
"""
网格交易策略多股票回测
策略：
1. 初始 100 万全仓买入
2. 低于初始价 30%，每下跌 10% 加仓 5%（需要有现金）
3. 高于初始价 30%，每上涨 10% 减仓 5%
"""

import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta

INITIAL_CAPITAL = 1_000_000

# 网格参数（相对初始价）
BUY_TRIGGER_PCT = -0.30      # 跌破初始价 30% 开始加仓
BUY_INTERVAL_PCT = 0.10      # 每跌 10% 加仓一次
BUY_RATIO = 0.05             # 每次加仓 5%

SELL_TRIGGER_PCT = 0.30      # 涨超初始价 30% 开始减仓
SELL_INTERVAL_PCT = 0.10     # 每涨 10% 减仓一次
SELL_RATIO = 0.05            # 每次减仓 5%

STOCKS = {
    'NVDA': '英伟达',
    'AAPL': '苹果',
    'GOOGL': '谷歌',
    'META': 'Meta',
    'BRK-B': '伯克希尔'
}

def backtest_grid(ticker, name):
    """网格策略回测"""
    print(f"\n{'='*70}")
    print(f"正在回测: {name} ({ticker})")
    print(f"{'='*70}")

    # 获取数据
    end_date = datetime.now()
    start_date = end_date - timedelta(days=3*365)

    try:
        data = yf.download(ticker, start=start_date, end=end_date, progress=False)
    except Exception as e:
        print(f"❌ 获取 {name} 数据失败: {e}")
        return None

    if data.empty:
        print(f"❌ {name} 无数据")
        return None

    print(f"✓ 获取到 {len(data)} 天的数据 ({data.index[0].date()} ~ {data.index[-1].date()})")

    # 初始化：全仓买入
    initial_price = float(data['Close'].iloc[0])
    shares = INITIAL_CAPITAL / initial_price
    cash = 0
    trades = []

    # 计算网格价位
    buy_trigger_price = initial_price * (1 + BUY_TRIGGER_PCT)
    sell_trigger_price = initial_price * (1 + SELL_TRIGGER_PCT)

    buy_levels_triggered = set()
    sell_levels_triggered = set()

    print(f"  初始价格: ${initial_price:.2f}")
    print(f"  初始买入: {shares:.2f} 股")
    print(f"  加仓触发: < ${buy_trigger_price:.2f} (-30%)")
    print(f"  减仓触发: > ${sell_trigger_price:.2f} (+30%)\n")

    # 回测循环
    for date, row in data.iterrows():
        price = float(row['Close'])
        change_from_initial = (price - initial_price) / initial_price

        # 加仓逻辑：跌破初始价 30%，每跌 10% 加仓 5%
        if change_from_initial < BUY_TRIGGER_PCT:
            drop_from_trigger = abs(change_from_initial - BUY_TRIGGER_PCT)
            level_index = int(drop_from_trigger / BUY_INTERVAL_PCT)

            if level_index not in buy_levels_triggered:
                buy_amount = INITIAL_CAPITAL * BUY_RATIO
                if cash >= buy_amount:
                    buy_shares = buy_amount / price
                    cash -= buy_amount
                    shares += buy_shares
                    buy_levels_triggered.add(level_index)

                    trades.append({
                        'date': date.date(),
                        'action': 'BUY',
                        'price': price,
                        'shares': buy_shares,
                        'amount': buy_amount,
                        'change_pct': change_from_initial * 100
                    })

        # 减仓逻辑：涨超初始价 30%，每涨 10% 减仓 5%
        if change_from_initial > SELL_TRIGGER_PCT:
            rise_from_trigger = change_from_initial - SELL_TRIGGER_PCT
            level_index = int(rise_from_trigger / SELL_INTERVAL_PCT)

            if level_index not in sell_levels_triggered:
                sell_shares = (INITIAL_CAPITAL / initial_price) * SELL_RATIO
                if shares >= sell_shares:
                    sell_amount = sell_shares * price
                    cash += sell_amount
                    shares -= sell_shares
                    sell_levels_triggered.add(level_index)

                    trades.append({
                        'date': date.date(),
                        'action': 'SELL',
                        'price': price,
                        'shares': sell_shares,
                        'amount': sell_amount,
                        'change_pct': change_from_initial * 100
                    })

    # 最终结果
    final_price = float(data['Close'].iloc[-1])
    final_value = cash + shares * final_price
    total_return = (final_value - INITIAL_CAPITAL) / INITIAL_CAPITAL
    annualized_return = (final_value / INITIAL_CAPITAL) ** (1/3) - 1

    # 买入持有
    buy_hold_shares = INITIAL_CAPITAL / initial_price
    buy_hold_value = buy_hold_shares * final_price
    buy_hold_return = (buy_hold_value - INITIAL_CAPITAL) / INITIAL_CAPITAL

    print(f"📊 网格策略表现：")
    print(f"  最终价值:     ${final_value:,.0f}")
    print(f"  总收益率:     {total_return*100:.2f}%")
    print(f"  年化收益率:   {annualized_return*100:.2f}%")
    print(f"\n💰 持仓明细：")
    print(f"  现金:         ${cash:,.0f} ({cash/final_value*100:.1f}%)")
    print(f"  股票市值:     ${shares * final_price:,.0f} ({shares*final_price/final_value*100:.1f}%)")
    print(f"  当前股价:     ${final_price:.2f}")
    print(f"\n📈 对比买入持有：")
    print(f"  买入持有价值: ${buy_hold_value:,.0f}")
    print(f"  买入持有收益: {buy_hold_return*100:.2f}%")
    print(f"  策略差异:     {(total_return - buy_hold_return)*100:+.2f}%")
    print(f"\n📝 交易统计：")
    print(f"  总交易:       {len(trades)} 次")
    print(f"  加仓:         {sum(1 for t in trades if t['action'] == 'BUY')} 次")
    print(f"  减仓:         {sum(1 for t in trades if t['action'] == 'SELL')} 次")

    # 保存交易记录
    if trades:
        df_trades = pd.DataFrame(trades)
        df_trades.to_csv(f'/Users/bytedance/re-act/trades_{ticker}_grid.csv', index=False)
        print(f"  ✓ 交易记录已保存至 trades_{ticker}_grid.csv")

    return {
        'ticker': ticker,
        'name': name,
        'final_value': final_value,
        'total_return': total_return,
        'annualized_return': annualized_return,
        'buy_hold_return': buy_hold_return,
        'strategy_diff': total_return - buy_hold_return,
        'cash': cash,
        'shares': shares,
        'num_trades': len(trades),
        'num_buys': sum(1 for t in trades if t['action'] == 'BUY'),
        'num_sells': sum(1 for t in trades if t['action'] == 'SELL')
    }

# 执行回测
results = []
for ticker, name in STOCKS.items():
    result = backtest_grid(ticker, name)
    if result:
        results.append(result)

# 汇总对比
print(f"\n\n{'='*70}")
print(f"汇总对比 - 网格策略 vs 买入持有")
print(f"{'='*70}\n")

df_summary = pd.DataFrame(results)
df_summary = df_summary.sort_values('strategy_diff', ascending=False)

print(f"{'股票':<12} {'网格收益':<12} {'持有收益':<12} {'差异':<12} {'交易次数':<10}")
print(f"{'-'*70}")
for _, row in df_summary.iterrows():
    print(f"{row['name']:<10} {row['total_return']*100:>10.2f}%  {row['buy_hold_return']*100:>10.2f}%  {row['strategy_diff']*100:>10.2f}%  {row['num_trades']:>8}次")

# 保存汇总
df_summary.to_csv('/Users/bytedance/re-act/grid_strategy_summary.csv', index=False)
print(f"\n✓ 汇总结果已保存至 grid_strategy_summary.csv")
