import { expect, test } from '@playwright/test';

test.describe('WorkOffice — Suite E2E (Etapa 9)', () => {
  test('exibe landing page, Termos de Uso (/terms), Politica de Privacidade (/privacy) e formulario de Cadastro (/signup)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: /Seu escritorio virtual de agentes de IA/i }),
    ).toBeVisible();

    await page.getByRole('link', { name: /Termos de Uso/i }).click();
    await expect(page).toHaveURL(/\/terms$/);
    await expect(
      page.getByRole('heading', {
        name: /Termos de Uso e Responsabilidade sobre APIs e Direitos Autorais/i,
      }),
    ).toBeVisible();

    await page.getByRole('link', { name: /Ver Política de Privacidade/i }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(
      page.getByRole('heading', {
        name: /Política de Privacidade e Segurança do Cofre de Chaves/i,
      }),
    ).toBeVisible();

    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: /Criar Conta/i })).toBeVisible();
    await expect(page.getByLabel(/Nome de Exibicao/i)).toBeVisible();
    await expect(page.getByLabel(/E-mail/i)).toBeVisible();
  });

  test('protege rotas autenticadas (/app, /app/new-office, /app/credentials) redirecionando visitantes para /login', async ({
    page,
  }) => {
    await page.goto('/app/new-office');
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fnew-office/);
    await expect(page.getByRole('heading', { name: /Entrar no WorkOffice/i })).toBeVisible();
  });
});
