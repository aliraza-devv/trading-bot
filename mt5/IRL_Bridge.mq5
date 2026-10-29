//+------------------------------------------------------------------+
//|                                                   IRL_Bridge.mq5 |
//|  Executes the decisions of the local IRL -> ERL web app.         |
//|  DEMO ACCOUNTS ONLY: the EA refuses to start on a real account.  |
//+------------------------------------------------------------------+
//  What it does
//    After every closed M15 candle it sends the recent candles, your positions and your resting orders to the
//    web app on this PC (through a shared folder, or WebRequest) and gets back what to do: place a limit order, keep or cancel one, or tighten
//    a stop. It executes that, with its own hard limits on top (see the inputs). Between those decisions it
//    watches the price on every tick for the partial profit at +1R and then moves the stop to breakeven.
//
//  What it never does
//    - trade a real-money account
//    - touch orders or positions that are not its own (other magic number or other symbol)
//    - risk more than MaxRiskPct of equity, or more than MaxLots, whatever the server says
//    - open a position without a stop loss at the broker
//    - leave orders behind if the app stops answering (they expire after one candle, and a watchdog removes them)
//
//  Setup: see mt5/README.md
//+------------------------------------------------------------------+
#property copyright "IRL to ERL backtester"
#property version   "1.00"
#property description "Executes the decisions of the local IRL->ERL web app. Demo accounts only."

#include <Trade\Trade.mqh>

#define EA_VERSION "1.1"
#define FILE_DIR   "irl_bridge" // folder inside Common\Files shared with the app

//--- inputs ---------------------------------------------------------
input string ServerUrl       = "http://localhost:3001/api/bridge/decide"; // only used when UseWebRequest (last input) is true
input long   MagicNumber     = 5051501;  // marks this EA's orders and positions
input bool   DryRun          = false;    // true: log what it WOULD do, send no orders at all
input double MaxRiskPct      = 2.0;      // hard cap: % of equity risked per trade, whatever the server asks for
input double MaxLots         = 1.0;      // hard cap: lots per order
input double MaxDailyLossPct = 3.0;      // after losing this % of the day's starting equity, no new orders until tomorrow
input int    BarsToSend      = 3000;     // closed M15 candles sent each time (the rules need history to judge structure)
input int    DeviationPoints = 50;       // max slippage for market operations (the partial close)
input bool   UseWebRequest   = false;    // false (default): talk to the app through a shared folder, no setup needed. true: use WebRequest (needs the URL list)

//--- state ----------------------------------------------------------
struct Plan
{
   ulong  ticket;
   double partialPx;   // act when the BID reaches this price
   double frac;        // fraction of the position to close
   double be;          // stop to set afterwards (breakeven)
};

CTrade   g_trade;
Plan     g_plans[];
string   g_events[];               // messages for the app's activity log, sent with the next sync
datetime g_syncedBar   = 0;        // open time of the M15 candle we last synced for
datetime g_nextTry     = 0;        // do not retry before this (server time)
datetime g_lastOk      = 0;        // server time of the last successful sync
int      g_seq         = 0;        // counter that makes every request file name unique
string   g_lastStatus  = "waiting for the first sync";
int      g_day         = 0;        // yyyymmdd of the trading day being tracked
double   g_dayStartEq  = 0.0;
bool     g_halted      = false;    // daily loss limit reached

//--- forward declarations -------------------------------------------
void   Log(const string msg);
bool   IsDemo();
long   ServerOffsetSec();
double Floor2Step(const double v);
double NormPrice(const double p);
bool   HaveOwnPosition();
bool   HaveOwnPendings();
void   DeleteOwnPendings(const string why);
void   KeepOneTradeAtATime();
void   CheckDay();
void   LoadDayState();
bool   Sync();
bool   ExchangeViaFiles(const string body, string &resp);
bool   ExchangeViaWebRequest(const string body, string &resp);
bool   HandleResponse(const string resp);
void   DoPlace(const string dir, double price, double sl, double tp, const double riskPct, const datetime expUtc, const string comment);
void   DoRenew(const ulong ticket, double price, double sl, double tp, const datetime expUtc);
void   DoCancel(const ulong ticket, const string why);
void   DoTrail(const ulong ticket, double sl);
void   UpsertPlan(const ulong ticket, const double partialPx, const double frac, const double be);
int    FindPlan(const ulong ticket);
void   DropClosedPlans();
void   ManagePartials();
void   EnsureBreakeven(const ulong ticket, const double be);
void   ShowStatus();

//+------------------------------------------------------------------+
int OnInit()
{
   if(!IsDemo())
   {
      Alert("IRL bridge: this is NOT a demo account. The EA only runs on demo accounts, so it is stopping.");
      return(INIT_FAILED);
   }
   g_trade.SetExpertMagicNumber((ulong)MagicNumber);
   g_trade.SetDeviationInPoints((ulong)DeviationPoints);
   g_trade.SetTypeFillingBySymbol(_Symbol);
   g_lastOk = TimeCurrent();
   // Changing a setting re-runs OnInit but MT5 keeps the global variables. Forget the last sync so the new settings
   // take effect at once instead of at the next candle.
   g_syncedBar = 0;
   g_nextTry   = 0;
   LoadDayState();
   CheckDay();
   EventSetTimer(2);
   string mode = "";
   if(DryRun)
      mode = " DRY RUN: no orders will be sent.";
   Log("started, version " + EA_VERSION + " on " + _Symbol + "." + mode);
   ShowStatus();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
}

void OnTimer()
{
   CheckDay();
   KeepOneTradeAtATime();
   datetime bar = iTime(_Symbol, PERIOD_M15, 0); // open time of the candle forming right now
   if(bar != 0 && bar != g_syncedBar && TimeCurrent() >= g_nextTry)
   {
      if(Sync())
         g_syncedBar = bar;
      else
         g_nextTry = TimeCurrent() + 20;
   }
   ShowStatus();
}

void OnTick()
{
   ManagePartials();
   KeepOneTradeAtATime();
}

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
void Log(const string msg)
{
   Print("IRL bridge: ", msg);
   int n = ArraySize(g_events);
   if(n >= 30) // keep the newest 30 only
   {
      for(int i = 1; i < n; i++)
         g_events[i - 1] = g_events[i];
      n--;
      ArrayResize(g_events, n);
   }
   ArrayResize(g_events, n + 1);
   g_events[n] = msg;
}

bool IsDemo()
{
   return(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO);
}

// broker server time minus UTC, in seconds, rounded to 15 minutes
long ServerOffsetSec()
{
   long diff = (long)(TimeTradeServer() - TimeGMT());
   return((long)(MathRound((double)diff / 900.0) * 900.0));
}

double Floor2Step(const double v)
{
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0)
      step = 0.01;
   return(NormalizeDouble(MathFloor(v / step + 1e-9) * step, 8));
}

double NormPrice(const double p)
{
   double tick = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   if(tick > 0.0)
      return(NormalizeDouble(MathRound(p / tick) * tick, digits));
   return(NormalizeDouble(p, digits));
}

bool HaveOwnPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber)
         return(true);
   }
   return(false);
}

bool IsOwnPending(const ulong t)
{
   if(t == 0)
      return(false);
   if(OrderGetString(ORDER_SYMBOL) != _Symbol || OrderGetInteger(ORDER_MAGIC) != MagicNumber)
      return(false);
   long ty = OrderGetInteger(ORDER_TYPE);
   return(ty == ORDER_TYPE_BUY_LIMIT || ty == ORDER_TYPE_SELL_LIMIT);
}

bool HaveOwnPendings()
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong t = OrderGetTicket(i);
      if(IsOwnPending(t))
         return(true);
   }
   return(false);
}

void DeleteOwnPendings(const string why)
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong t = OrderGetTicket(i);
      if(!IsOwnPending(t))
         continue;
      if(DryRun)
      {
         Log("[dry run] would delete order " + IntegerToString((long)t) + ": " + why);
         continue;
      }
      if(g_trade.OrderDelete(t))
         Log("deleted order " + IntegerToString((long)t) + ": " + why);
      else
         Log("could not delete order " + IntegerToString((long)t) + ": " + g_trade.ResultRetcodeDescription());
   }
}

// One trade at a time, and no stale orders:
//  - once one of our orders has filled, the other resting orders are removed
//  - watchdog: if the app has not answered for 20 minutes, every resting order is removed
void KeepOneTradeAtATime()
{
   static datetime last = 0;
   datetime now = TimeCurrent();
   if(now == last)
      return;
   last = now;
   if(HaveOwnPosition())
   {
      if(HaveOwnPendings())
         DeleteOwnPendings("a position is open");
      return;
   }
   if(g_lastOk > 0 && now - g_lastOk > 20 * 60 && HaveOwnPendings())
      DeleteOwnPendings("no successful contact with the app for 20 minutes");
}

//+------------------------------------------------------------------+
//| Daily loss limit (survives a restart through terminal globals)   |
//+------------------------------------------------------------------+
void LoadDayState()
{
   if(GlobalVariableCheck("IRL_DAY") && GlobalVariableCheck("IRL_DAYEQ"))
   {
      g_day        = (int)GlobalVariableGet("IRL_DAY");
      g_dayStartEq = GlobalVariableGet("IRL_DAYEQ");
      g_halted     = GlobalVariableCheck("IRL_HALT") && (int)GlobalVariableGet("IRL_HALT") == g_day;
   }
}

void CheckDay()
{
   MqlDateTime t;
   TimeToStruct(TimeTradeServer(), t);
   int today = t.year * 10000 + t.mon * 100 + t.day;
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(today != g_day || g_dayStartEq <= 0.0)
   {
      g_day        = today;
      g_dayStartEq = eq;
      g_halted     = false;
      GlobalVariableSet("IRL_DAY", (double)today);
      GlobalVariableSet("IRL_DAYEQ", eq);
      GlobalVariableDel("IRL_HALT");
   }
   if(!g_halted && g_dayStartEq > 0.0 && eq <= g_dayStartEq * (1.0 - MaxDailyLossPct / 100.0))
   {
      g_halted = true;
      GlobalVariableSet("IRL_HALT", (double)today);
      Log("daily loss limit of " + DoubleToString(MaxDailyLossPct, 1) + "% reached: no new orders until tomorrow.");
      if(!DryRun)
         DeleteOwnPendings("daily loss limit");
   }
}

//+------------------------------------------------------------------+
//| One round trip to the app                                        |
//+------------------------------------------------------------------+
bool Sync()
{
   if(!IsDemo())
   {
      Log("not a demo account: refusing to trade.");
      return(false);
   }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && !DryRun)
      Log("the Algo Trading button in the toolbar is OFF: orders will be refused until you switch it on.");

   MqlRates rates[];
   ArraySetAsSeries(rates, false);               // oldest first
   int got = CopyRates(_Symbol, PERIOD_M15, 1, BarsToSend, rates); // start at 1: the candle forming now is left out
   if(got < 600)
   {
      Log("only " + IntegerToString(got) + " M15 candles available so far; MT5 may still be downloading history. Will retry.");
      return(false);
   }

   long   off    = ServerOffsetSec();
   int    digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double tick   = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double bid    = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask    = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   bool   netting = ((ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_NETTING);

   string body = "";
   body += "v=1\n";
   body += "ea=" + EA_VERSION + "\n";
   body += "symbol=" + _Symbol + "\n";
   body += "nowUtc=" + IntegerToString((long)TimeGMT()) + "\n";
   body += "serverOffsetSec=" + IntegerToString(off) + "\n";
   body += "equity=" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "\n";
   body += "balance=" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "\n";
   body += "currency=" + AccountInfoString(ACCOUNT_CURRENCY) + "\n";
   body += "demo=1\n";
   body += "netting=" + (netting ? "1" : "0") + "\n";
   body += "dryRun=" + (DryRun ? "1" : "0") + "\n";
   body += "digits=" + IntegerToString(digits) + "\n";
   body += "point=" + DoubleToString(point, 8) + "\n";
   body += "tickSize=" + DoubleToString(tick, 8) + "\n";
   body += "spreadNow=" + DoubleToString(MathMax(0.0, ask - bid), digits) + "\n";

   // our open positions
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != MagicNumber)
         continue;
      string c = PositionGetString(POSITION_COMMENT);
      StringReplace(c, "|", " ");
      bool isBuy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      body += "POS|" + IntegerToString((long)t) + "|" + (isBuy ? "B" : "S") + "|" +
              DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + "|" +
              DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), digits) + "|" +
              DoubleToString(PositionGetDouble(POSITION_SL), digits) + "|" +
              DoubleToString(PositionGetDouble(POSITION_TP), digits) + "|" +
              IntegerToString((long)PositionGetInteger(POSITION_TIME) - off) + "|" + c + "\n";
   }

   // our resting orders
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong t = OrderGetTicket(i);
      if(!IsOwnPending(t))
         continue;
      string c = OrderGetString(ORDER_COMMENT);
      StringReplace(c, "|", " ");
      bool isBuy = (OrderGetInteger(ORDER_TYPE) == ORDER_TYPE_BUY_LIMIT);
      body += "ORD|" + IntegerToString((long)t) + "|" + (isBuy ? "BL" : "SL") + "|" +
              DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) + "|" +
              DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN), digits) + "|" +
              DoubleToString(OrderGetDouble(ORDER_SL), digits) + "|" +
              DoubleToString(OrderGetDouble(ORDER_TP), digits) + "|" + c + "\n";
   }

   // what we logged since the last sync (shown on the app's Live page)
   for(int i = 0; i < ArraySize(g_events); i++)
   {
      string e = g_events[i];
      StringReplace(e, "|", " ");
      StringReplace(e, "\n", " ");
      body += "EVT|" + e + "\n";
   }
   ArrayResize(g_events, 0);

   // the candles, in chunks of 100 lines so the string is not copied thousands of times
   int start = 0;
   while(start < got)
   {
      string part = "";
      int stop = MathMin(got, start + 100);
      for(int k = start; k < stop; k++)
      {
         part += "BAR|" + IntegerToString((long)rates[k].time - off) + "|" +
                 DoubleToString(rates[k].open, digits) + "|" + DoubleToString(rates[k].high, digits) + "|" +
                 DoubleToString(rates[k].low, digits) + "|" + DoubleToString(rates[k].close, digits) + "|" +
                 IntegerToString(rates[k].spread) + "\n";
      }
      body += part;
      start = stop;
   }

   string resp = "";
   bool   exchanged;
   if(UseWebRequest)
      exchanged = ExchangeViaWebRequest(body, resp);
   else
      exchanged = ExchangeViaFiles(body, resp);
   if(!exchanged)
      return(false);
   return(HandleResponse(resp));
}

// Default transport: a shared folder (Common\Files\irl_bridge). The app watches it and answers within a second.
// No ports, no URL list: MT5's WebRequest refuses http://localhost:3001 (error 4014) even when it is listed.
bool ExchangeViaFiles(const string body, string &resp)
{
   FolderCreate(FILE_DIR, FILE_COMMON);
   g_seq++;
   string id      = IntegerToString((long)GetTickCount()) + "_" + IntegerToString(g_seq);
   string tmpName  = FILE_DIR + "\\req_" + id + ".tmp";
   string reqName  = FILE_DIR + "\\req_" + id + ".txt";
   string respName = FILE_DIR + "\\resp_" + id + ".txt";

   char data[];
   int n = StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   ArrayResize(data, n);
   ResetLastError();
   int h = FileOpen(tmpName, FILE_WRITE | FILE_BIN | FILE_COMMON);
   if(h == INVALID_HANDLE)
   {
      g_lastStatus = "cannot write to the shared folder (error " + IntegerToString(GetLastError()) + ")";
      Print("IRL bridge: ", g_lastStatus);
      return(false);
   }
   FileWriteArray(h, data, 0, n);
   FileClose(h);
   // write under a temporary name, then rename: the app never sees a half-written request
   if(!FileMove(tmpName, FILE_COMMON, reqName, FILE_COMMON | FILE_REWRITE))
   {
      g_lastStatus = "cannot hand the request to the app (error " + IntegerToString(GetLastError()) + ")";
      Print("IRL bridge: ", g_lastStatus);
      FileDelete(tmpName, FILE_COMMON);
      return(false);
   }

   // wait for the answer (the app polls twice a second)
   uint t0 = GetTickCount();
   while(!FileIsExist(respName, FILE_COMMON) && GetTickCount() - t0 < 20000)
      Sleep(200);
   if(!FileIsExist(respName, FILE_COMMON))
   {
      FileDelete(reqName, FILE_COMMON); // withdraw it so the app does not answer a request nobody waits for
      g_lastStatus = "no answer from the app. Is it running? (npm run bridge)";
      Print("IRL bridge: ", g_lastStatus);
      return(false);
   }
   h = FileOpen(respName, FILE_READ | FILE_BIN | FILE_COMMON | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE)
   {
      g_lastStatus = "cannot read the app's answer (error " + IntegerToString(GetLastError()) + ")";
      Print("IRL bridge: ", g_lastStatus);
      return(false);
   }
   char buf[];
   FileReadArray(h, buf);
   FileClose(h);
   FileDelete(respName, FILE_COMMON);
   resp = CharArrayToString(buf, 0, WHOLE_ARRAY, CP_UTF8);
   return(true);
}

// Optional transport (UseWebRequest = true). MT5 only allows listed domains on the standard web ports, so this
// usually fails for http://localhost:3001 with error 4014. Kept for setups where it works (e.g. an https address).
bool ExchangeViaWebRequest(const string body, string &resp)
{
   char data[];
   char result[];
   string resultHeaders;
   int n = StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   ArrayResize(data, n);
   ResetLastError();
   int code = WebRequest("POST", ServerUrl, "Content-Type: text/plain\r\n", 15000, data, result, resultHeaders);
   if(code == -1)
   {
      int err = GetLastError();
      if(err == 4060 || err == 4014)
         g_lastStatus = "WebRequest refused (error " + IntegerToString(err) + "): set UseWebRequest = false to use the shared folder instead";
      else
         g_lastStatus = "cannot reach the app (error " + IntegerToString(err) + "). Is it running?";
      Print("IRL bridge: ", g_lastStatus);
      return(false);
   }
   resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(code != 200)
   {
      g_lastStatus = "the app answered HTTP " + IntegerToString(code) + ": " + StringSubstr(resp, 0, 120);
      Log(g_lastStatus);
      return(false);
   }
   return(true);
}

bool HandleResponse(const string resp)
{
   string lines[];
   int n = StringSplit(resp, '\n', lines);
   bool ok = false;
   int noteShown = 0;
   for(int i = 0; i < n; i++)
   {
      string line = lines[i];
      StringReplace(line, "\r", "");
      if(StringLen(line) == 0)
         continue;
      string f[];
      int nf = StringSplit(line, '|', f);
      if(nf < 1)
         continue;
      string cmd = f[0];
      if(cmd == "OK")
      {
         ok = true;
         g_lastStatus = (nf > 3 ? f[3] : "ok");
      }
      else if(cmd == "NOTE")
      {
         if(noteShown < 3 && nf > 1)
         {
            Print("IRL bridge: ", f[1]);
            noteShown++;
         }
      }
      else if(cmd == "PLACE" && nf >= 8)
         DoPlace(f[1], StringToDouble(f[2]), StringToDouble(f[3]), StringToDouble(f[4]), StringToDouble(f[5]),
                 (datetime)StringToInteger(f[6]), f[7]);
      else if(cmd == "RENEW" && nf >= 6)
         DoRenew((ulong)StringToInteger(f[1]), StringToDouble(f[2]), StringToDouble(f[3]), StringToDouble(f[4]),
                 (datetime)StringToInteger(f[5]));
      else if(cmd == "CANCEL" && nf >= 2)
         DoCancel((ulong)StringToInteger(f[1]), (nf > 2 ? f[2] : ""));
      else if(cmd == "SL" && nf >= 3)
         DoTrail((ulong)StringToInteger(f[1]), StringToDouble(f[2]));
      else if(cmd == "PLAN" && nf >= 5)
         UpsertPlan((ulong)StringToInteger(f[1]), StringToDouble(f[2]), StringToDouble(f[3]), StringToDouble(f[4]));
   }
   if(!ok)
   {
      g_lastStatus = "unexpected answer from the app: " + StringSubstr(resp, 0, 120);
      Log(g_lastStatus);
      return(false);
   }
   DropClosedPlans();
   g_lastOk = TimeCurrent();
   return(true);
}

//+------------------------------------------------------------------+
//| Executing the app's instructions (each one re-checked here)      |
//+------------------------------------------------------------------+
void DoPlace(const string dir, double price, double sl, double tp, const double riskPct, const datetime expUtc, const string comment)
{
   if(g_halted)
   {
      Log("daily loss limit reached: not placing " + comment);
      return;
   }
   if(HaveOwnPosition())
   {
      Log("a position is open: not placing " + comment);
      return;
   }
   bool buy = (dir == "B");
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   price = NormPrice(price);
   sl    = NormPrice(sl);
   tp    = NormPrice(tp);

   // a stop is mandatory, and stop / target must be on the correct sides
   if(sl <= 0.0 || tp <= 0.0 || (buy && !(sl < price && price < tp)) || (!buy && !(tp < price && price < sl)))
   {
      Log("rejected " + comment + ": stop, entry and target are inconsistent.");
      return;
   }

   double bid     = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask     = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double minDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   if(buy && price > ask - minDist)
   {
      Log("skipped " + comment + ": the buy limit " + DoubleToString(price, digits) + " is not below the market any more.");
      return;
   }
   if(!buy && price < bid + minDist)
   {
      Log("skipped " + comment + ": the sell limit " + DoubleToString(price, digits) + " is not above the market any more.");
      return;
   }
   if(MathAbs(price - sl) < minDist || MathAbs(price - tp) < minDist)
   {
      Log("skipped " + comment + ": stop or target too close to the entry for this broker.");
      return;
   }

   // lots from the risk budget: equity x risk% / loss per lot if the stop is hit
   double risk     = MathMin(riskPct, MaxRiskPct);
   double tick     = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickVal  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickVal <= 0.0)
      tickVal = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   if(tick <= 0.0 || tickVal <= 0.0 || risk <= 0.0)
   {
      Log("cannot size " + comment + ": the symbol's tick size or tick value is unknown.");
      return;
   }
   double lossPerLot = MathAbs(price - sl) / tick * tickVal;
   double lots = AccountInfoDouble(ACCOUNT_EQUITY) * risk / 100.0 / lossPerLot;
   lots = Floor2Step(MathMin(lots, MaxLots));
   lots = MathMin(lots, SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX));
   double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   if(lots < vmin)
   {
      Log("skipped " + comment + ": the risk budget gives " + DoubleToString(lots, 2) + " lots, below the broker minimum " + DoubleToString(vmin, 2) + ".");
      return;
   }
   double margin = 0.0;
   if(OrderCalcMargin(buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, _Symbol, lots, price, margin) && margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE))
   {
      Log("skipped " + comment + ": not enough free margin for " + DoubleToString(lots, 2) + " lots.");
      return;
   }

   string desc = (buy ? "buy" : "sell") + " limit " + DoubleToString(lots, 2) + " lots at " + DoubleToString(price, digits) +
                 ", stop " + DoubleToString(sl, digits) + ", target " + DoubleToString(tp, digits) +
                 ", risk " + DoubleToString(risk, 2) + "% (" + comment + ")";
   if(DryRun)
   {
      Log("[dry run] would place " + desc);
      return;
   }
   datetime expiry = (datetime)((long)expUtc + ServerOffsetSec());
   bool done;
   if(buy)
      done = g_trade.BuyLimit(lots, price, _Symbol, sl, tp, ORDER_TIME_SPECIFIED, expiry, comment);
   else
      done = g_trade.SellLimit(lots, price, _Symbol, sl, tp, ORDER_TIME_SPECIFIED, expiry, comment);
   if(!done) // some brokers do not accept an expiry: retry without one (the watchdog still removes stale orders)
   {
      if(buy)
         done = g_trade.BuyLimit(lots, price, _Symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      else
         done = g_trade.SellLimit(lots, price, _Symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
   }
   if(done)
      Log("placed " + desc);
   else
      Log("order rejected (" + g_trade.ResultRetcodeDescription() + "): " + desc);
}

void DoRenew(const ulong ticket, double price, double sl, double tp, const datetime expUtc)
{
   if(!OrderSelect(ticket) || !IsOwnPending(ticket))
      return;
   if(DryRun)
      return;
   price = NormPrice(price);
   sl    = NormPrice(sl);
   tp    = NormPrice(tp);
   datetime expiry = (datetime)((long)expUtc + ServerOffsetSec());
   bool ok = g_trade.OrderModify(ticket, price, sl, tp, ORDER_TIME_SPECIFIED, expiry);
   if(!ok && g_trade.ResultRetcode() == TRADE_RETCODE_NO_CHANGES)
      ok = true;
   if(!ok)
      ok = g_trade.OrderModify(ticket, price, sl, tp, ORDER_TIME_GTC, 0);
   if(!ok && g_trade.ResultRetcode() == TRADE_RETCODE_NO_CHANGES)
      ok = true;
   if(!ok)
      Log("could not renew order " + IntegerToString((long)ticket) + ": " + g_trade.ResultRetcodeDescription());
}

void DoCancel(const ulong ticket, const string why)
{
   if(!OrderSelect(ticket) || !IsOwnPending(ticket)) // never touch an order that is not ours
      return;
   if(DryRun)
   {
      Log("[dry run] would cancel order " + IntegerToString((long)ticket) + ": " + why);
      return;
   }
   if(g_trade.OrderDelete(ticket))
      Log("cancelled order " + IntegerToString((long)ticket) + ": " + why);
   else
      Log("could not cancel order " + IntegerToString((long)ticket) + ": " + g_trade.ResultRetcodeDescription());
}

// Tighten a stop (candle-close trailing). Never loosens it.
void DoTrail(const ulong ticket, double sl)
{
   if(!PositionSelectByTicket(ticket))
      return;
   if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != MagicNumber)
      return;
   bool   buy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   double cur = PositionGetDouble(POSITION_SL);
   double tp  = PositionGetDouble(POSITION_TP);
   sl = NormPrice(sl);
   if(cur > 0.0 && (buy ? sl <= cur : sl >= cur))
      return;
   double minDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   if(buy && sl > SymbolInfoDouble(_Symbol, SYMBOL_BID) - minDist)
      return;
   if(!buy && sl < SymbolInfoDouble(_Symbol, SYMBOL_ASK) + minDist)
      return;
   if(DryRun)
   {
      Log("[dry run] would trail the stop of " + IntegerToString((long)ticket) + " to " + DoubleToString(sl, 2));
      return;
   }
   if(g_trade.PositionModify(ticket, sl, tp))
      Log("trailed the stop of position " + IntegerToString((long)ticket) + " to " + DoubleToString(sl, 2));
   else
      Log("could not trail the stop of " + IntegerToString((long)ticket) + ": " + g_trade.ResultRetcodeDescription());
}

//+------------------------------------------------------------------+
//| Partial profit and breakeven (every tick)                        |
//+------------------------------------------------------------------+
int FindPlan(const ulong ticket)
{
   for(int i = 0; i < ArraySize(g_plans); i++)
      if(g_plans[i].ticket == ticket)
         return(i);
   return(-1);
}

void UpsertPlan(const ulong ticket, const double partialPx, const double frac, const double be)
{
   int p = FindPlan(ticket);
   if(p < 0)
   {
      p = ArraySize(g_plans);
      ArrayResize(g_plans, p + 1);
   }
   g_plans[p].ticket    = ticket;
   g_plans[p].partialPx = partialPx;
   g_plans[p].frac      = frac;
   g_plans[p].be        = be;
}

void DropClosedPlans()
{
   for(int i = ArraySize(g_plans) - 1; i >= 0; i--)
   {
      if(PositionSelectByTicket(g_plans[i].ticket))
         continue;
      GlobalVariableDel("IRL_DONE_" + IntegerToString((long)g_plans[i].ticket));
      int last = ArraySize(g_plans) - 1;
      g_plans[i] = g_plans[last];
      ArrayResize(g_plans, last);
   }
}

void ManagePartials()
{
   if(ArraySize(g_plans) == 0)
      return;
   double bid  = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != MagicNumber)
         continue;
      int p = FindPlan(ticket);
      if(p < 0)
         continue;
      bool   buy     = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      string doneKey = "IRL_DONE_" + IntegerToString((long)ticket);
      if(!GlobalVariableCheck(doneKey))
      {
         bool hit = (buy ? bid >= g_plans[p].partialPx : bid <= g_plans[p].partialPx);
         if(!hit)
            continue;
         double vol  = PositionGetDouble(POSITION_VOLUME);
         double part = Floor2Step(vol * g_plans[p].frac);
         bool   okClose = true;
         if(part >= vmin && part < vol - 1e-9)
            okClose = g_trade.PositionClosePartial(ticket, part);
         else if(part >= vol - 1e-9)
            okClose = g_trade.PositionClose(ticket);
         // else: the partial is smaller than the smallest tradable lot, so only the breakeven move happens
         if(!okClose)
         {
            Log("partial close failed (" + g_trade.ResultRetcodeDescription() + "); will retry on the next tick.");
            continue;
         }
         GlobalVariableSet(doneKey, 1.0); // set right after the close so a failed stop move can never repeat the partial
         if(part >= vmin)
            Log("took " + DoubleToString(part, 2) + " lots off position " + IntegerToString((long)ticket) + " at the partial level.");
         else
            Log("partial level reached on position " + IntegerToString((long)ticket) + ": the partial is below the smallest lot, so only the stop moves to breakeven.");
         if(!PositionSelectByTicket(ticket))
            continue; // closed completely
      }
      EnsureBreakeven(ticket, g_plans[p].be);
   }
}

// Move the stop to breakeven; retried (at most every 3 seconds) until it is in place.
void EnsureBreakeven(const ulong ticket, const double be)
{
   static datetime lastTry = 0;
   if(!PositionSelectByTicket(ticket))
      return;
   bool   buy    = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   double sl     = PositionGetDouble(POSITION_SL);
   double tp     = PositionGetDouble(POSITION_TP);
   double target = NormPrice(be);
   if(sl > 0.0 && (buy ? sl >= target - 1e-9 : sl <= target + 1e-9))
      return; // already at breakeven or better (the app may have trailed it further)
   if(TimeCurrent() - lastTry < 3)
      return;
   lastTry = TimeCurrent();
   double minDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   if(buy && target > SymbolInfoDouble(_Symbol, SYMBOL_BID) - minDist)
      return;
   if(!buy && target < SymbolInfoDouble(_Symbol, SYMBOL_ASK) + minDist)
      return;
   if(DryRun)
      return;
   if(g_trade.PositionModify(ticket, target, tp))
      Log("stop of position " + IntegerToString((long)ticket) + " moved to breakeven " + DoubleToString(target, 2) + ".");
   else
      Log("could not move the stop to breakeven (" + g_trade.ResultRetcodeDescription() + "); will retry.");
}

//+------------------------------------------------------------------+
void ShowStatus()
{
   string s = "IRL bridge v" + EA_VERSION;
   if(DryRun)
      s += "  [DRY RUN]";
   s += "\nDEMO account | " + _Symbol + "\n";
   s += "Last contact with the app: " + (g_lastOk > 0 ? TimeToString(g_lastOk, TIME_DATE | TIME_SECONDS) : "never") + "\n";
   s += "Status: " + g_lastStatus + "\n";
   if(g_halted)
      s += "HALTED: daily loss limit reached, no new orders today\n";
   Comment(s);
}
//+------------------------------------------------------------------+
