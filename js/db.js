// ============================================================
//  FinanzasJuntos — Funciones de base de datos
// ============================================================

const DB = {

  // ── PERFIL ──────────────────────────────────────────────
  async getProfile() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data } = await sb.from('profiles').select('*').eq('id', user.id).single();
    return data;
  },

  async updateProfile(updates) {
    const { data: { user } } = await sb.auth.getUser();
    return sb.from('profiles').update(updates).eq('id', user.id);
  },

  // ── PAREJA ──────────────────────────────────────────────
  async getCouple() {
    const { data: { user } } = await sb.auth.getUser();
    const { data } = await sb.from('couples')
      .select('*, user1:user1_id(name,email,avatar_color), user2:user2_id(name,email,avatar_color)')
      .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
      .eq('status', 'active')
      .single();
    return data;
  },

  async createCoupleInvite() {
    const { data: { user } } = await sb.auth.getUser();
    const { data } = await sb.from('couples')
      .insert({ user1_id: user.id })
      .select().single();
    return data;
  },

  async joinCouple(inviteCode) {
    const { data: { user } } = await sb.auth.getUser();
    const { data: couple } = await sb.from('couples')
      .select('*').eq('invite_code', inviteCode).eq('status', 'pending').single();
    if (!couple) return { error: 'Código inválido o ya usado' };
    const { error } = await sb.from('couples')
      .update({ user2_id: user.id, status: 'active' })
      .eq('id', couple.id);
    return { error, couple };
  },

  // ── CUENTAS ─────────────────────────────────────────────
  async getAccounts(includeArchived = false) {
    const { data: { user } } = await sb.auth.getUser();
    let query = sb.from('accounts').select('*').eq('user_id', user.id).order('created_at');
    if (!includeArchived) query = query.eq('is_archived', false);
    const { data } = await query;
    return data || [];
  },

  async getPartnerAccounts() {
    const couple = await this.getCouple();
    if (!couple) return [];
    const { data: { user } } = await sb.auth.getUser();
    const partnerId = couple.user1_id === user.id ? couple.user2_id : couple.user1_id;
    const { data } = await sb.from('accounts')
      .select('*')
      .eq('user_id', partnerId)
      .eq('visible_to_partner', true)
      .eq('is_archived', false);
    return data || [];
  },

  async createAccount(account) {
    const { data: { user } } = await sb.auth.getUser();
    const { data, error } = await sb.from('accounts')
      .insert({ ...account, user_id: user.id })
      .select().single();
    return { data, error };
  },

  async updateAccount(id, updates) {
    return sb.from('accounts').update(updates).eq('id', id);
  },

  async updateAccountBalance(accountId, newBalance) {
    return sb.from('accounts').update({ balance: newBalance }).eq('id', accountId);
  },

  // ── TASAS ───────────────────────────────────────────────
  async getCachedRate(currency) {
    const { data } = await sb.from('exchange_rates')
      .select('*').eq('currency', currency).single();
    return data;
  },

  // ── CATEGORÍAS ──────────────────────────────────────────
  async getCategories() {
    const { data: { user } } = await sb.auth.getUser();
    const { data } = await sb.from('budget_categories')
      .select('*')
      .or(`is_system.eq.true,user_id.eq.${user.id}`)
      .order('sort_order');
    return data || [];
  },

  async createCategory(cat) {
    const { data: { user } } = await sb.auth.getUser();
    const { data, error } = await sb.from('budget_categories')
      .insert({ ...cat, user_id: user.id, is_system: false })
      .select().single();
    return { data, error };
  },

  // ── PRESUPUESTOS ─────────────────────────────────────────
  async getBudgets(month, year) {
    const { data: { user } } = await sb.auth.getUser();
    const { data } = await sb.from('budgets')
      .select('*, category:category_id(*)')
      .eq('user_id', user.id)
      .eq('month', month)
      .eq('year', year);
    return data || [];
  },

  async upsertBudget(categoryId, amount, currency, month, year) {
    const { data: { user } } = await sb.auth.getUser();
    return sb.from('budgets').upsert({
      user_id: user.id, category_id: categoryId,
      amount, currency, month, year
    }, { onConflict: 'user_id,category_id,month,year' });
  },

  // ── TRANSACCIONES ────────────────────────────────────────
  async getTransactions({ limit = 50, offset = 0, accountId, month, year } = {}) {
    const { data: { user } } = await sb.auth.getUser();
    let query = sb.from('transactions')
      .select('*, account:account_id(name,currency,icon,color), category:category_id(name,icon,color)')
      .eq('user_id', user.id)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (accountId) query = query.eq('account_id', accountId);
    if (month && year) {
      const from = `${year}-${String(month).padStart(2,'0')}-01`;
      const to   = `${year}-${String(month).padStart(2,'0')}-31`;
      query = query.gte('date', from).lte('date', to);
    }
    const { data } = await query;
    return data || [];
  },

  async createTransaction(tx) {
    const { data: { user } } = await sb.auth.getUser();
    const { data, error } = await sb.from('transactions')
      .insert({ ...tx, user_id: user.id })
      .select().single();
    if (!error) {
      // Actualizar saldo de la cuenta
      const { data: acc } = await sb.from('accounts')
        .select('balance').eq('id', tx.account_id).single();
      if (acc) {
        const delta = tx.type === 'income' ? tx.amount_native : -tx.amount_native;
        await this.updateAccountBalance(tx.account_id, acc.balance + delta);
      }
    }
    return { data, error };
  },

  async updateTransaction(id, updates) {
    return sb.from('transactions').update(updates).eq('id', id);
  },

  async deleteTransaction(id) {
    // Primero revertir el saldo
    const { data: tx } = await sb.from('transactions').select('*').eq('id', id).single();
    if (tx) {
      const { data: acc } = await sb.from('accounts').select('balance').eq('id', tx.account_id).single();
      if (acc) {
        const delta = tx.type === 'income' ? -tx.amount_native : tx.amount_native;
        await this.updateAccountBalance(tx.account_id, acc.balance + delta);
      }
    }
    return sb.from('transactions').delete().eq('id', id);
  },

  // Resumen de gastos por categoría en un mes
  async getSpendingByCategory(month, year) {
    const { data: { user } } = await sb.auth.getUser();
    const from = `${year}-${String(month).padStart(2,'0')}-01`;
    const to   = `${year}-${String(month).padStart(2,'0')}-31`;
    const { data } = await sb.from('transactions')
      .select('category_id, amount_usd, type')
      .eq('user_id', user.id)
      .eq('type', 'expense')
      .gte('date', from).lte('date', to);

    const totals = {};
    (data || []).forEach(t => {
      const key = t.category_id || 'uncategorized';
      totals[key] = (totals[key] || 0) + parseFloat(t.amount_usd);
    });
    return totals;
  },

  // Totales del mes (ingresos y gastos)
  async getMonthlyTotals(month, year) {
    const { data: { user } } = await sb.auth.getUser();
    const from = `${year}-${String(month).padStart(2,'0')}-01`;
    const to   = `${year}-${String(month).padStart(2,'0')}-31`;
    const { data } = await sb.from('transactions')
      .select('type, amount_usd')
      .eq('user_id', user.id)
      .gte('date', from).lte('date', to);

    let income = 0, expenses = 0;
    (data || []).forEach(t => {
      if (t.type === 'income' || t.type === 'interest') income += parseFloat(t.amount_usd);
      else if (t.type === 'expense') expenses += parseFloat(t.amount_usd);
    });
    return { income, expenses, balance: income - expenses };
  },

  // ── TRANSFERENCIAS ───────────────────────────────────────
  async createTransfer(transfer) {
    const { data: { user } } = await sb.auth.getUser();

    // Calcular tasa implícita
    const implicitRate = transfer.from_currency !== transfer.to_currency
      ? transfer.to_amount / transfer.from_amount
      : 1;

    const fromUsd = await Rates.toUSD(transfer.from_amount, transfer.from_currency);

    const { data, error } = await sb.from('transfers')
      .insert({
        ...transfer,
        user_id: user.id,
        implicit_rate: implicitRate,
        from_amount_usd: fromUsd
      }).select().single();

    if (!error) {
      // Actualizar saldos de ambas cuentas
      const { data: fromAcc } = await sb.from('accounts').select('balance').eq('id', transfer.from_account_id).single();
      const { data: toAcc }   = await sb.from('accounts').select('balance').eq('id', transfer.to_account_id).single();
      if (fromAcc) await this.updateAccountBalance(transfer.from_account_id, fromAcc.balance - transfer.from_amount);
      if (toAcc)   await this.updateAccountBalance(transfer.to_account_id,   toAcc.balance   + transfer.to_amount);
    }
    return { data, error };
  },

  // ── CUOTAS ───────────────────────────────────────────────
  async getInstallments(accountId) {
    let query = sb.from('installment_plans').select('*').eq('is_active', true);
    if (accountId) query = query.eq('account_id', accountId);
    const { data } = await query.order('next_due_date');
    return data || [];
  },

  async createInstallment(plan) {
    const { data: { user } } = await sb.auth.getUser();
    const { data, error } = await sb.from('installment_plans')
      .insert({ ...plan, user_id: user.id }).select().single();
    return { data, error };
  },

  // ── PRÉSTAMOS ────────────────────────────────────────────
  async getLoans() {
    const { data: { user } } = await sb.auth.getUser();
    const { data } = await sb.from('loans')
      .select('*').eq('user_id', user.id).eq('is_active', true);
    return data || [];
  },

  async createLoan(loan) {
    const { data: { user } } = await sb.auth.getUser();
    const { data, error } = await sb.from('loans')
      .insert({ ...loan, user_id: user.id }).select().single();
    return { data, error };
  },

  // ── DINERO PRESTADO ──────────────────────────────────────
  async getMoneyLent() {
    const { data: { user } } = await sb.auth.getUser();
    const { data } = await sb.from('money_lent')
      .select('*').eq('user_id', user.id).order('date_lent', { ascending: false });
    return data || [];
  },

  async createMoneyLent(item) {
    const { data: { user } } = await sb.auth.getUser();
    const amountUsd = await Rates.toUSD(item.amount, item.currency);
    const { data, error } = await sb.from('money_lent')
      .insert({ ...item, user_id: user.id, amount_usd: amountUsd }).select().single();
    return { data, error };
  },

  // ── NEGOCIOS ─────────────────────────────────────────────
  async getBusinesses() {
    const { data: { user } } = await sb.auth.getUser();
    const { data } = await sb.from('businesses')
      .select('*').eq('user_id', user.id).eq('is_active', true);
    return data || [];
  },

  async createBusiness(biz) {
    const { data: { user } } = await sb.auth.getUser();
    const { data, error } = await sb.from('businesses')
      .insert({ ...biz, user_id: user.id }).select().single();
    return { data, error };
  },

  async getBusinessIncome(businessId) {
    const { data } = await sb.from('business_income')
      .select('*').eq('business_id', businessId).order('date', { ascending: false });
    return data || [];
  },

  async addBusinessIncome(income) {
    const { data: { user } } = await sb.auth.getUser();
    const amountUsd = await Rates.toUSD(income.amount, income.currency);
    const rate = income.currency !== 'USD' ? await Rates.getRate(income.currency) : 1;
    const { data, error } = await sb.from('business_income')
      .insert({ ...income, user_id: user.id, amount_usd: amountUsd, rate_used: rate })
      .select().single();
    return { data, error };
  },

  // ── FUENTES DE INGRESO ───────────────────────────────────
  async getIncomeSources() {
    const { data: { user } } = await sb.auth.getUser();
    const { data } = await sb.from('income_sources')
      .select('*, account:account_id(name,icon)')
      .eq('user_id', user.id).eq('is_active', true);
    return data || [];
  },

  async createIncomeSource(source) {
    const { data: { user } } = await sb.auth.getUser();
    const { data, error } = await sb.from('income_sources')
      .insert({ ...source, user_id: user.id }).select().single();
    return { data, error };
  },

  // ── METAS DE AHORRO ──────────────────────────────────────
  async getGoals() {
    const { data: { user } } = await sb.auth.getUser();
    const { data } = await sb.from('savings_goals')
      .select('*').eq('user_id', user.id).eq('is_completed', false)
      .order('created_at');
    return data || [];
  },

  async createGoal(goal) {
    const { data: { user } } = await sb.auth.getUser();
    const { data, error } = await sb.from('savings_goals')
      .insert({ ...goal, user_id: user.id }).select().single();
    return { data, error };
  },

  async addGoalContribution(goalId, amount, currency) {
    const { data: { user } } = await sb.auth.getUser();
    const amountUsd = await Rates.toUSD(amount, currency);
    await sb.from('goal_contributions')
      .insert({ goal_id: goalId, user_id: user.id, amount, currency, amount_usd: amountUsd, date: new Date().toISOString().split('T')[0] });
    // Actualizar current_amount
    const { data: goal } = await sb.from('savings_goals').select('current_amount, target_amount').eq('id', goalId).single();
    if (goal) {
      const newAmount = parseFloat(goal.current_amount) + parseFloat(amountUsd);
      const isCompleted = newAmount >= parseFloat(goal.target_amount);
      await sb.from('savings_goals').update({ current_amount: newAmount, is_completed: isCompleted }).eq('id', goalId);
    }
  },

  // ── CRÉDITO ──────────────────────────────────────────────
  async updateCreditLimit(accountId, newLimit, changeDate) {
    const { data: acc } = await sb.from('accounts').select('credit_limit').eq('id', accountId).single();
    if (acc) {
      await sb.from('credit_limit_history').insert({
        account_id: accountId,
        old_limit: acc.credit_limit,
        new_limit: newLimit,
        changed_at: changeDate
      });
    }
    return sb.from('accounts').update({
      credit_limit: newLimit,
      last_limit_increase_date: changeDate
    }).eq('id', accountId);
  }
};