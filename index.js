require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const moment = require("moment");
const cors = require("cors");
const mysql = require("mysql2");

const app = express();
app.use(cors({ origin: "http://localhost:5173", credentials: true }));
app.use(express.json());

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect();

// Configuração do Nodemailer para envio de e-mails
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false, // true para 465, false para outras portas
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Função para enviar e-mail
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

// Função para incrementar a dívida
const incrementarDivida = async () => {
  try {
    // Busca Todas as dívidas no banco de dados
    const [rows] = await db.promise().query("SELECT id, divida, ultima_atualizacao FROM dividas");

    if (rows.length === 0) {
      console.log("Nenhuma dívida encontrada.");
      return;
    }

    // Itera sobre cada dívida
    for (const divida of rows) {
      const novaDivida = divida.divida + 10; // Incremento de 10 Kz

      // Envia e-mail 1 minuto antes do incremento
      const assunto = "Aviso: Incremento de Dívida";
      const texto = `Sua dívida será incrementada em 10 Kz em 1 minuto. A nova dívida será de ${novaDivida} Kz.`;
      await enviarEmail(process.env.EMAIL_TO, assunto, texto);

      console.log(`E-mail enviado para ${process.env.EMAIL_TO} sobre o incremento da dívida ID ${divida.id}.`);

      // Aguarda 1 minuto antes de incrementar a dívida
      setTimeout(async () => {
        await db.promise().query("UPDATE dividas SET divida = ?, ultima_atualizacao = NOW() WHERE id = ?", [novaDivida, divida.id]);
        console.log(`Dívida do ID ${divida.id} incrementada para ${novaDivida} Kz.`);
      }, 60000); // 1 minuto
    }
  } catch (error) {
    console.error("Erro ao incrementar dívida:", error);
  }
};

// Agenda o incremento da dívida a cada 3 minutos
setInterval(incrementarDivida, 180000); // 3 minutos = 180000 ms

// Endpoint para obter a dívida atual
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

// Endpoint para subtrair valor da dívida
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

    // Atualiza a dívida no banco
    await db.promise().query("UPDATE dividas SET divida = ?, ultima_atualizacao = NOW() WHERE id = ?", [novaDivida, id]);

    // Registra o pagamento no histórico
    await db.promise().query("INSERT INTO historico_pagamentos (id_divida, valor_pago) VALUES (?, ?)", [id, valor]);

    // Mantém apenas os últimos 15 registros no histórico
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

// Endpoint para obter histórico de pagamentos
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

// Endpoint para verificar se a dívida foi incrementada
app.get("/divida/:id/incrementada", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.promise().query("SELECT ultima_atualizacao FROM dividas WHERE id = ?", [id]);

    if (rows.length === 0) return res.status(404).json({ message: "Dívida não encontrada" });

    const ultimaAtualizacao = new Date(rows[0].ultima_atualizacao);
    const agora = new Date();
    const diferencaEmMinutos = Math.floor((agora - ultimaAtualizacao) / (1000 * 60)); // Diferença em minutos

    // Se a dívida foi atualizada nos últimos 1 minuto, retorne true
    if (diferencaEmMinutos <= 1) {
      return res.json({ incrementada: true });
    } else {
      return res.json({ incrementada: false });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Erro ao verificar incremento da dívida" });
  }
});

// Inicia o servidor
app.listen(5000, () => console.log("Servidor rodando na porta 5000"));
