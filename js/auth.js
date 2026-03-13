// ============================================================
//  FinanzasJuntos — Auth
//  Depende de sb (definido en config.js)
// ============================================================

const Auth = {

  async getUser() {
    const { data: { user } } = await sb.auth.getUser();
    return user;
  },

  async signUp(email, password, name) {
    return sb.auth.signUp({
      email,
      password,
      options: { data: { name } }
    });
  },

  async signIn(email, password) {
    return sb.auth.signInWithPassword({ email, password });
  },

  async signOut() {
    await sb.auth.signOut();
    window.location.href = 'index.html';
  },

  async isOnboardingComplete() {
    const { data } = await sb.from('accounts').select('id').limit(1);
    return data && data.length > 0;
  }
};