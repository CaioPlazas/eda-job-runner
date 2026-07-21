// Parameterized synchronous FIFO (single clock).
// Used to buffer bytes on both the TX and RX sides of the UART subsystem.
module sync_fifo #(
    parameter WIDTH = 8,
    parameter DEPTH = 16
) (
    input  wire             clk,
    input  wire             rst_n,

    input  wire             wr_en,
    input  wire [WIDTH-1:0] wr_data,
    output wire             full,

    input  wire                  rd_en,
    output wire [WIDTH-1:0]      rd_data,
    output wire                  empty,

    output wire [$clog2(DEPTH):0] level
);
    // ADDR_W bits address DEPTH entries; the extra count bit distinguishes
    // full from empty.
    localparam ADDR_W = $clog2(DEPTH);

    reg [WIDTH-1:0] mem [0:DEPTH-1];
    reg [ADDR_W:0]  wr_ptr;
    reg [ADDR_W:0]  rd_ptr;

    wire do_wr = wr_en & ~full;
    wire do_rd = rd_en & ~empty;

    assign empty = (wr_ptr == rd_ptr);
    assign full  = (wr_ptr[ADDR_W] != rd_ptr[ADDR_W]) &&
                   (wr_ptr[ADDR_W-1:0] == rd_ptr[ADDR_W-1:0]);
    assign level = wr_ptr - rd_ptr;

    // First-word fall-through read: rd_data always presents the head entry
    // combinationally, so a consumer can use it *before* asserting rd_en (which
    // just advances to the next entry). uart_tx relies on this — it latches the
    // head at tx_start and only pops after the byte has been sent.
    assign rd_data = mem[rd_ptr[ADDR_W-1:0]];

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wr_ptr <= 0;
        end else if (do_wr) begin
            mem[wr_ptr[ADDR_W-1:0]] <= wr_data;
            wr_ptr <= wr_ptr + 1'b1;
        end
    end

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rd_ptr <= 0;
        end else if (do_rd) begin
            rd_ptr <= rd_ptr + 1'b1;
        end
    end
endmodule
