const readline = require("readline");
const fs = require("fs");
const proxy = require("node-global-proxy").default;
const libgen = require("libgen");
const axios = require("axios");
const cheerio = require("cheerio");
const { MultiBar, Presets } = require("cli-progress");
const { createClient } = require("redis");

function capitalize(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

(async () => {
  const redisClient = createClient();
  redisClient.on("error", (err) => console.log("Redis Client Error", err));
  await redisClient.connect();

  // =============== Config =============== //

  const query = capitalize("Existentialist");
  const toTry = 20;
  const bookDir = "./books/";
  const goodreads_books_query_left_lines = "goodreads_books_query_left_lines";
  const goodreadsBooksFile = "./goodreads_books.json";

  // =============== Stat-line Number =============== //

  let startLineNum = await redisClient.hGet(
    goodreads_books_query_left_lines,
    query
  );
  if (startLineNum == null) {
    startLineNum = 1;
  }

  const goodreadsBooksFileLines = 2360655;
  if (startLineNum == goodreadsBooksFileLines) {
    console.log("This query has exhausted the Goodreads database.");
    process.exit();
  }

  // =============== Setup =============== //

  // Only effective for libgen package.
  proxy.setConfig({
    http: "http://127.0.0.1:7890",
    https: "https://127.0.0.1:7890",
  });
  proxy.start();

  const readInterface = readline.createInterface({
    input: fs.createReadStream(goodreadsBooksFile),
    output: process.stdout,
    terminal: false,
  });

  // =============== For each line =============== //

  let currentLineNum = 0;
  let tried = 0;
  for await (const line of readInterface) {
    currentLineNum++;
    if (currentLineNum < startLineNum) {
      continue;
    }
    if (currentLineNum == goodreadsBooksFileLines) {
      console.log("This query has exhausted the Goodreads database.");
      process.exit();
    }

    if (tried == toTry) {
      console.log(`You have tried ${toTry} books`);
      process.exit();
    }

    redisClient.hSet(goodreads_books_query_left_lines, query, currentLineNum);

    let bookJson;
    try {
      bookJson = JSON.parse(line);
    } catch (error) {
      console.error("Error parsing JSON:", error);
    }

    // =============== Qualifaction check =============== //

    let title = bookJson.title;
    if (!title.includes(query)) {
      //console.log(`No query: ${title}`);
      continue;
    }

    if (bookJson.ratings_count < 100) {
      console.log("Rating count");
      continue;
    }

    if (bookJson.average_rating < 3.5) {
      console.log("Rating");
      continue;
    }

    const isbn = bookJson.isbn;
    if (!isbn) {
      console.log("No ISBN");
      continue;
    }

    const tried_goodreads_book_ids = "tried_goodreads_book_ids";
    const book_id = bookJson.book_id;
    if (await redisClient.sIsMember(tried_goodreads_book_ids, book_id)) {
      console.log("Tried");
      continue;
    }
    redisClient.sAdd(tried_goodreads_book_ids, book_id);

    let shouldAvoid = false;
    const words = title.split(/[\s:'0-9]+/);
    for (const word of words) {
      if (await redisClient.sIsMember("avoided_keywords", word)) {
        console.log(`${word} --- ${title}`);
        shouldAvoid = true;
        break;
      }
    }
    if (shouldAvoid) {
      continue;
    }

    // =============== Qualified =============== //

    const options = {
      mirror: "http://libgen.is",
      query: isbn,
      search_in: "identifier",
      // filesize sorting is from min to max.
      sort_by: "filesize",
      //reverse: true,
      //count: 5,
    };

    let data;
    try {
      data = await libgen.search(options);
    } catch (error) {
      console.log(error);
    }

    let n = data.length;
    if (n) {
      console.log(title);
      //console.log(`${n} Libgen results`);
    } else {
      console.log("Libgen not found");
      continue;
    }

    tried++;
    title = title.replace(/:/g, " -");
    const publication_year = bookJson.publication_year;

    // =============== For each Libgen result =============== //

    for (const item of data) {
      console.log(item.filesize);
    }

    let epub_tried = false;
    let pdf_tried = false;
    // For each Libgen result:
    while (n--) {
      const extension = data[n].extension;

      // =============== Check =============== //

      if (epub_tried && pdf_tried) {
        break;
      }

      if (parseInt(data[n].filesize) > 20000000) {
        continue;
      }

      if (!epub_tried && extension == "epub") {
        epub_tried = true;
      } else if (!pdf_tried && extension == "pdf") {
        pdf_tried = true;
      } else {
        continue;
      }

      // =============== Download =============== //

      const downloadPage =
        "http://libgen.li/ads.php?md5=" + data[n].md5.toLowerCase();

      const response = await axios.get(downloadPage);

      const $ = cheerio.load(response.data);
      const $downloadUrl = $("table[id=main] a");
      const downloadUrl = "http://libgen.li/" + $downloadUrl[0].attribs.href;

      if (downloadUrl) {
        let bookFileName =
          bookDir + `${title} (${publication_year}).${extension}`;
        if (!publication_year) {
          bookFileName = bookDir + `${title}.${extension}`;
        }

        // Create a new progress bar
        const multiBar = new MultiBar(Presets.shades_classic);

        const progressBar = multiBar.create(100, 0);

        let downloadResponse;
        try {
          downloadResponse = await axios({
            url: downloadUrl,
            method: "get",
            responseType: "stream",
            setTimeout: 10000,
          });
        } catch (error) {
          console.error(
            "Download timed out or encountered an error:",
            error.message
          );
          continue;
        }

        // Get the total file size from the response headers
        const totalSize = parseInt(
          downloadResponse.headers["content-length"],
          10
        );

        // Create a writable stream for the downloaded file
        const writer = fs.createWriteStream(bookFileName);

        // Define the current downloaded bytes
        let downloadedBytes = 0;

        // Pipe the response stream to a writable file stream and update the progress bar
        downloadResponse.data.on("data", (chunk) => {
          downloadedBytes += chunk.length;
          const progress = (downloadedBytes / totalSize) * 100;
          progressBar.update(progress);
        });

        downloadResponse.data.pipe(writer);

        // Wait for the writer to finish writing the file
        await new Promise((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });

        // Close the progress bar
        multiBar.stop();
      } else {
        console.error("Link not found in the table.");
      }
    }
  }
})();
