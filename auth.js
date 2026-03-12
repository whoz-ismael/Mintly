// ============================================================
//  FinanzasJuntos — Autenticación y Onboarding
// ============================================================

const Auth = {

  async getUser() {
    const { data: { user } } = await supabase.auth.getUser();
    return user;
  },

  async signUp(email, password, name) {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { name } }
    });
    return { data, error };
  },

  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    return { data, error };
  },

  async signOut() {
    await supabase.auth.signOut();
    window.location.href = 'index.html';
  },

  async isOnboardingComplete() {
    const { data } = await supabase.from('accounts').select('id').limit(1);
    return data && data.length > 0;
  }
};
