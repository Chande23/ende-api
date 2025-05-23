require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const moment = require("moment");
const cors = require("cors");
const mysql = require("mysql2");

const app = express();
app.use(cors({ origin: "https://ende-app.vercel.app", credentials: true }));
app.use(express.json());

// Configuração do banco de dados
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});


db.connect(err => {
  if (err) {
    console.error('Erro ao conectar no banco:', err);
  } else {
    console.log('Conectado ao MySQL do Clever Cloud!');
  }
});

module.exports = db;

// Configuração do Nodemailer
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Constantes de tempo
const INTERVALO_INCREMENTO = 300000; // 5 minutos em milissegundos
const TEMPO_AVISO_INCREMENTO = 180000; // Aviso no 2º minuto (3 minutos antes)
const TEMPO_LED_AMARELO = 60000; // 1 minuto para o LED amarelo

// Variável para controle do intervalo
let intervaloIncremento;

// Funções auxiliares
const enviarEmail = async (destinatario, assunto, texto) => {
  try {
    const info = await transporter.sendMail({
      from: `"Sistema de Dívidas" <${process.env.EMAIL_USER}>`,
      to: destinatario,
      subject: assunto,
      text: texto,
    });
    console.log("E-mail enviado:", info.messageId);
  } catch (error) {
    console.error("Erro ao enviar e-mail:", error);
  }
};

const enviarConfirmacaoPagamento = async (destinatario, valorPago, novaDivida) => {
  const assunto = "Confirmação de Pagamento";
  const texto = `Seu pagamento de ${valorPago} Kz foi recebido com sucesso! Sua nova dívida é de ${novaDivida} Kz.`;
  await enviarEmail(destinatario, assunto, texto);
};

const enviarNotificacaoDivida = async (dividaAtual) => {
  let assunto, texto;
  
  if (dividaAtual > 20 && dividaAtual <= 40) {
    assunto = "Aviso de Dívida Pendente";
    texto = `Sua dívida atual é de ${dividaAtual} Kz. Por favor, regularize seu pagamento.`;
  } else if (dividaAtual > 40 && dividaAtual <= 50) {
    assunto = "Dívida Elevada";
    texto = `ATENÇÃO: Sua dívida está em ${dividaAtual} Kz. A dívida está ficando demasiado elevada.`;
  } else if (dividaAtual > 50) {
    assunto = "Dívida Crítica";
    texto = `URGENTE: Sua dívida atingiu ${dividaAtual} Kz. Liquide a dívida para evitar interrupção no serviço.`;
  }

  if (assunto && texto) {
    await enviarEmail(process.env.EMAIL_TO, assunto, texto);
  }
};

const registrarHistoricoDivida = async (id_divida, valor_divida) => {
  await db.promise().query(
    "INSERT INTO historico_dividas (id_divida, valor_divida) VALUES (?, ?)",
    [id_divida, valor_divida]
  );

  // Limita o histórico aos últimos 20 registros
  const [historico] = await db.promise().query(
    `SELECT id FROM historico_dividas 
     WHERE id_divida = ? 
     ORDER BY data_registro DESC 
     LIMIT 20`, 
    [id_divida]
  );

  const idsParaManter = historico.map(row => row.id);

  if (idsParaManter.length > 0) {
    await db.promise().query(
      `DELETE FROM historico_dividas 
       WHERE id_divida = ? 
       AND id NOT IN (${idsParaManter.join(",")})`, 
      [id_divida]
    );
  }
};

// Função principal para incrementar dívidas
const incrementarDivida = async () => {
  try {
    const [ids] = await db.promise().query("SELECT id FROM dividas");

    for (const row of ids) {
      // Busca o valor atual para cada dívida
      const [currentDebt] = await db.promise().query(
        "SELECT divida FROM dividas WHERE id = ?", 
        [row.id]
      );
      
      const novaDivida = currentDebt[0].divida + 10;
      
      // Envia aviso 3 minutos antes
      setTimeout(async () => {
        const assunto = "Aviso: Incremento de Dívida em 2 minutos";
        const texto = `Sua dívida será incrementada em 10 Kz em 2 minutos. Nova dívida: ${novaDivida} Kz.`;
        await enviarEmail(process.env.EMAIL_TO, assunto, texto);
      }, TEMPO_AVISO_INCREMENTO);

      // Incrementa após 5 minutos
      setTimeout(async () => {
        // Verifica novamente o valor atual antes de incrementar
        const [verificacao] = await db.promise().query(
          "SELECT divida FROM dividas WHERE id = ?", 
          [row.id]
        );
        
        const valorAtual = verificacao[0].divida;
        const novoValor = valorAtual + 10;
        
        await db.promise().query(
          "UPDATE dividas SET divida = ?, ultima_atualizacao = NOW() WHERE id = ?", 
          [novoValor, row.id]
        );
        
        await registrarHistoricoDivida(row.id, novoValor);
        await enviarNotificacaoDivida(novoValor);
        
        console.log(`Dívida ID ${row.id} incrementada para ${novoValor} Kz.`);
      }, INTERVALO_INCREMENTO);
    }
  } catch (error) {
    console.error("Erro ao incrementar dívida:", error);
  }
};

// Inicia o intervalo de incremento
const iniciarIntervaloIncremento = () => {
  if (intervaloIncremento) clearInterval(intervaloIncremento);
  intervaloIncremento = setInterval(incrementarDivida, INTERVALO_INCREMENTO);
  console.log(`Incremento de dívida configurado para cada ${INTERVALO_INCREMENTO/60000} minutos`);
};

// Endpoints
app.get("/divida/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.promise().query("SELECT divida FROM dividas WHERE id = ?", [id]);

    if (rows.length === 0) return res.status(404).json({ message: "Dívida não encontrada" });

    res.json({ divida: rows[0].divida });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Erro ao buscar a dívida" });
  }
});

app.post("/divida/:id/subtrair", async (req, res) => {
  const { id } = req.params;
  const { valor } = req.body;

  if (valor < 10) {
    return res.status(400).json({ message: "O valor mínimo para subtrair é 10 Kz" });
  }

  try {
    const [rows] = await db.promise().query("SELECT divida FROM dividas WHERE id = ?", [id]);

    if (rows.length === 0) return res.status(404).json({ message: "Dívida não encontrada" });

    const dividaAtual = rows[0].divida;

    if (dividaAtual < valor) {
      return res.status(400).json({ message: "Dívida insuficiente para subtrair o valor" });
    }

    const novaDivida = dividaAtual - valor;

    await db.promise().query(
      "UPDATE dividas SET divida = ?, ultima_atualizacao = NOW() WHERE id = ?", 
      [novaDivida, id]
    );

    await registrarHistoricoDivida(id, novaDivida);
    await db.promise().query(
      "INSERT INTO historico_pagamentos (id_divida, valor_pago) VALUES (?, ?)", 
      [id, valor]
    );
    
    await enviarConfirmacaoPagamento(process.env.EMAIL_TO, valor, novaDivida);

    // Limita o histórico de pagamentos aos últimos 15 registros
    const [historico] = await db.promise().query(
      `SELECT id FROM historico_pagamentos 
       WHERE id_divida = ? 
       ORDER BY data_pagamento DESC 
       LIMIT 15`, 
      [id]
    );

    const idsParaManter = historico.map(row => row.id);

    if (idsParaManter.length > 0) {
      await db.promise().query(
        `DELETE FROM historico_pagamentos 
         WHERE id_divida = ? 
         AND id NOT IN (${idsParaManter.join(",")})`, 
        [id]
      );
    }

    res.json({ divida: novaDivida });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Erro ao subtrair valor da dívida" });
  }
});

app.get("/historico-divida/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.promise().query(
      "SELECT valor_divida, data_registro FROM historico_dividas WHERE id_divida = ? ORDER BY data_registro ASC",
      [id]
    );

    res.json({ historico: rows });
  } catch (error) {
    console.error("Erro ao buscar histórico de dívida:", error);
    res.status(500).json({ message: "Erro ao obter histórico" });
  }
});

app.get("/historico-pagamentos/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.promise().query(
      "SELECT valor_pago, data_pagamento FROM historico_pagamentos WHERE id_divida = ? ORDER BY data_pagamento DESC",
      [id]
    );

    res.json({ historico: rows });
  } catch (error) {
    console.error("Erro ao buscar histórico de pagamentos:", error);
    res.status(500).json({ message: "Erro ao obter histórico" });
  }
});

app.get("/divida/:id/incrementada", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.promise().query(
      "SELECT ultima_atualizacao FROM dividas WHERE id = ?", 
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ message: "Dívida não encontrada" });

    const ultimaAtualizacao = new Date(rows[0].ultima_atualizacao);
    const agora = new Date();
    const diferenca = agora - ultimaAtualizacao;
    
    // Considera como incrementada se foi nos últimos 1 minuto
    res.json({ incrementada: diferenca <= TEMPO_LED_AMARELO });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Erro ao verificar incremento" });
  }
});

// Inicia o servidor e o intervalo de incremento
app.listen(5000, () => {
  console.log("Servidor rodando na porta 5000");
  iniciarIntervaloIncremento();
});